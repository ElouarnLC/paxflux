#!/usr/bin/env bash
#
# PaxFlux — Docker fresh-boot smoke test.
#
# Builds the image that is actually shipped (the repository Dockerfile, not a
# CI-only variant) and boots it exactly once, from nothing: brand-new anonymous
# volumes for /data and /backups, no seeded database, no mounted fixture. The
# point is to prove that a first-time self-hosted install comes up on its own.
#
# It asserts, in order:
#   1. the image builds;
#   2. the container is still running after boot;
#   3. the image's own HEALTHCHECK reaches "healthy";
#   4. GET /health/live answers 200;
#   5. GET /health/ready answers 200 (so SQLite opened and migrated);
#   6. the frontend is served (index.html with the SPA mount point);
#   7. the server process runs as the intended non-root user.
#
# Everything is bounded by a timeout so a hung boot fails instead of hanging
# the job, and the container plus both volumes are removed on every exit path.

set -euo pipefail

IMAGE_TAG="${PAXFLUX_SMOKE_IMAGE:-paxflux:smoke}"
CONTAINER_NAME="${PAXFLUX_SMOKE_CONTAINER:-paxflux-smoke-$$}"
HOST_PORT="${PAXFLUX_SMOKE_PORT:-3979}"
DATA_VOLUME="paxflux-smoke-data-$$"
BACKUP_VOLUME="paxflux-smoke-backups-$$"

# The image HEALTHCHECK is --start-period=5s --interval=15s --retries=3, so a
# cold boot legitimately needs a few probe cycles before Docker reports healthy.
HEALTHY_TIMEOUT_S="${PAXFLUX_SMOKE_HEALTHY_TIMEOUT_S:-120}"

# The user baked into the Dockerfile runner stage.
EXPECTED_USER="paxflux"
EXPECTED_UID="10001"
EXPECTED_GID="10001"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '    \033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    log "Smoke failed (exit ${status}) — container diagnostics"
    docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format \
      'state={{.State}} status={{.Status}}' || true
    echo '--- last 100 log lines ---'
    docker logs --tail 100 "$CONTAINER_NAME" 2>&1 || true
    echo '--- healthcheck probes ---'
    docker inspect --format '{{json .State.Health}}' "$CONTAINER_NAME" 2>/dev/null || true
    echo
  fi
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" "$BACKUP_VOLUME" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

# --- 1. build the shipped image ---------------------------------------------
log "Building ${IMAGE_TAG} from the shipped Dockerfile"
# PAXFLUX_SMOKE_EXTRA_BUILD_ARGS is an escape hatch for build environments that
# intercept TLS (corporate proxy, sandboxed runner) and therefore need a CA
# injected into the base image, e.g. via BuildKit's --build-context. It only
# ever *adds* docker build flags; it cannot weaken any assertion below, and CI
# leaves it empty so the gate builds the Dockerfile with no extra flags at all.
# shellcheck disable=SC2086
docker build ${PAXFLUX_SMOKE_EXTRA_BUILD_ARGS:-} -t "$IMAGE_TAG" -f "${REPO_ROOT}/Dockerfile" "$REPO_ROOT"
ok "image built"

# --- 2. boot it on virgin volumes -------------------------------------------
log "Booting a fresh container on empty volumes"
# Volumes are created empty and are exclusive to this run: no local database,
# no tests/e2e/.data, nothing carried over from a previous boot.
docker volume create "$DATA_VOLUME" >/dev/null
docker volume create "$BACKUP_VOLUME" >/dev/null

docker run -d \
  --name "$CONTAINER_NAME" \
  -p "127.0.0.1:${HOST_PORT}:3000" \
  -v "${DATA_VOLUME}:/data" \
  -v "${BACKUP_VOLUME}:/backups" \
  "$IMAGE_TAG" >/dev/null
ok "container started as ${CONTAINER_NAME}"

# --- 3. the image's own HEALTHCHECK must reach healthy ----------------------
log "Waiting for the image HEALTHCHECK to report healthy (max ${HEALTHY_TIMEOUT_S}s)"
started_at=$(date +%s)
health="unknown"
while :; do
  state=$(docker inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "gone")
  if [ "$state" != "running" ]; then
    fail "container is '${state}' — it did not stay up"
  fi

  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER_NAME")
  case "$health" in
    healthy)   break ;;
    unhealthy) fail "HEALTHCHECK reported unhealthy" ;;
    none)      fail "image declares no HEALTHCHECK — the shipped Dockerfile must keep one" ;;
  esac

  if [ $(( $(date +%s) - started_at )) -ge "$HEALTHY_TIMEOUT_S" ]; then
    fail "still '${health}' after ${HEALTHY_TIMEOUT_S}s"
  fi
  sleep 2
done
elapsed=$(( $(date +%s) - started_at ))
ok "healthy after ${elapsed}s (container stayed running throughout)"

BASE_URL="http://127.0.0.1:${HOST_PORT}"

http_status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1"; }

# --- 4/5. liveness and readiness --------------------------------------------
log "Probing the health endpoints from outside the container"
live_status=$(http_status "${BASE_URL}/health/live")
[ "$live_status" = "200" ] || fail "GET /health/live returned ${live_status}, expected 200"
live_body=$(curl -s --max-time 10 "${BASE_URL}/health/live")
echo "$live_body" | grep -q '"status":"ok"' \
  || fail "GET /health/live body is not {\"status\":\"ok\",...}: ${live_body}"
ok "GET /health/live -> 200 ${live_body}"

ready_status=$(http_status "${BASE_URL}/health/ready")
[ "$ready_status" = "200" ] || fail "GET /health/ready returned ${ready_status}, expected 200"
ready_body=$(curl -s --max-time 10 "${BASE_URL}/health/ready")
echo "$ready_body" | grep -q '"status":"ready"' \
  || fail "GET /health/ready body is not {\"status\":\"ready\",...}: ${ready_body}"
ok "GET /health/ready -> 200 ${ready_body}"

# --- 6. the frontend is actually served -------------------------------------
log "Checking that the built frontend is served by the image"
root_status=$(http_status "${BASE_URL}/")
[ "$root_status" = "200" ] || fail "GET / returned ${root_status}, expected 200"
root_body=$(curl -s --max-time 10 "${BASE_URL}/")
echo "$root_body" | grep -qi '<div id="root"' \
  || fail "GET / did not return the SPA shell (no #root mount point)"
echo "$root_body" | grep -qi 'PaxFlux' \
  || fail "GET / returned a document that does not look like the PaxFlux shell"
ok "GET / -> 200, SPA shell with the #root mount point"

# --- 7. non-root runtime ------------------------------------------------------
log "Checking the runtime user"
runtime_id=$(docker exec "$CONTAINER_NAME" id)
runtime_uid=$(docker exec "$CONTAINER_NAME" id -u)
runtime_gid=$(docker exec "$CONTAINER_NAME" id -g)
runtime_user=$(docker exec "$CONTAINER_NAME" id -un)

[ "$runtime_uid" != "0" ] || fail "the container runs as root (uid 0)"
[ "$runtime_uid" = "$EXPECTED_UID" ] \
  || fail "expected uid ${EXPECTED_UID}, got ${runtime_uid}"
[ "$runtime_gid" = "$EXPECTED_GID" ] \
  || fail "expected gid ${EXPECTED_GID}, got ${runtime_gid}"
[ "$runtime_user" = "$EXPECTED_USER" ] \
  || fail "expected user '${EXPECTED_USER}', got '${runtime_user}'"
ok "runtime identity: ${runtime_id}"

# The server process itself, not just the exec session.
server_owner=$(docker exec "$CONTAINER_NAME" sh -c \
  "ps -o user= -o args= | grep '[a]pps/server/dist/server.js' | head -1 | awk '{print \$1}'")
[ -n "$server_owner" ] || fail "could not find the node server process in the container"
[ "$server_owner" != "root" ] \
  || fail "the node server process runs as root"
ok "node apps/server/dist/server.js runs as '${server_owner}'"

log "Docker fresh-boot smoke PASSED (healthy in ${elapsed}s)"
