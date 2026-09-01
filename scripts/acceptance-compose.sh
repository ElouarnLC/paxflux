#!/usr/bin/env bash
#
# PaxFlux — operator acceptance for the documented Docker Compose install.
#
# The Phase 9 smoke proves the *image* boots. This proves the *published
# quickstart*: `docker compose up -d` on a machine with no node_modules, no
# dist, no data and no backups, followed by the two recovery paths an operator
# will actually need — a restart, and a restore from a snapshot.
#
# Covers Phase 10 §4 (restart / persistence), §5 (backup / restore) and
# §6 (real compose install).
#
# Everything is bounded by a timeout, and the stack plus its named volumes are
# removed on every exit path.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export PAXFLUX_PORT="${PAXFLUX_PORT:-3980}"
BASE_URL="http://127.0.0.1:${PAXFLUX_PORT}"
PROJECT="paxflux-acceptance-$$"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml)

HEALTHY_TIMEOUT_S="${PAXFLUX_ACCEPTANCE_HEALTHY_TIMEOUT_S:-180}"

ADMIN_USER="acceptance-operator"
ADMIN_PASS="AcceptanceCompose!2026"

WORK_DIR="$(mktemp -d)"
COOKIE_JAR="${WORK_DIR}/cookies.txt"

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
info() { printf '    ..   %s\n' "$*"; }
fail() { printf '    \033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    log "Acceptance failed (exit ${status}) — diagnostics"
    "${COMPOSE[@]}" ps || true
    "${COMPOSE[@]}" logs --tail 120 paxflux 2>&1 || true
  fi
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

# The compose file names the image `paxflux:latest` and also knows how to build
# it. Build environments that intercept TLS need a CA injected into the base
# image, which `docker compose build` cannot express; when
# PAXFLUX_ACCEPTANCE_PREBUILD_ARGS is set the image is built once with those
# extra flags and compose then simply uses it. Left empty — as in CI — compose
# builds the shipped Dockerfile itself, exactly as the README says.
prepare_image() {
  if [ -n "${PAXFLUX_ACCEPTANCE_PREBUILD_ARGS:-}" ]; then
    log "Pre-building paxflux:latest (extra build flags supplied by the environment)"
    # shellcheck disable=SC2086
    docker build ${PAXFLUX_ACCEPTANCE_PREBUILD_ARGS} -t paxflux:latest -f "${REPO_ROOT}/Dockerfile" "$REPO_ROOT"
    ok "image pre-built"
  fi
}

wait_healthy() {
  local started_at container
  started_at=$(date +%s)
  while :; do
    container=$("${COMPOSE[@]}" ps -q paxflux)
    [ -n "$container" ] || fail "no paxflux container is running"

    local state health
    state=$(docker inspect --format '{{.State.Status}}' "$container")
    [ "$state" = "running" ] || fail "container is '${state}' — it did not stay up"

    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
    case "$health" in
      healthy)   break ;;
      unhealthy) fail "compose healthcheck reported unhealthy" ;;
      none)      fail "the compose service declares no healthcheck" ;;
    esac

    if [ $(( $(date +%s) - started_at )) -ge "$HEALTHY_TIMEOUT_S" ]; then
      fail "still '${health}' after ${HEALTHY_TIMEOUT_S}s"
    fi
    sleep 2
  done
  echo $(( $(date +%s) - started_at ))
}

api() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -o "${WORK_DIR}/body.json" -w '%{http_code}' --max-time 20
              -b "$COOKIE_JAR" -c "$COOKIE_JAR" -X "$method"
              -H "Origin: ${BASE_URL}")
  [ -n "${CSRF_TOKEN:-}" ] && args+=(-H "x-csrf-token: ${CSRF_TOKEN}")
  if [ "$method" != "GET" ]; then
    # Fastify rejects an empty body that claims to be JSON, so a bodyless
    # mutation sends an empty object rather than a bare content-type header.
    local payload="$body"
    [ -z "$payload" ] && payload='{}'
    args+=(-H 'Content-Type: application/json' --data "$payload")
  fi
  curl "${args[@]}" "${BASE_URL}${path}"
}

jqf() { python3 -c "import json,sys;d=json.load(open('${WORK_DIR}/body.json'));print($1)"; }

# ---------------------------------------------------------------------------
log "§6.1 — no leftover state: the install must start from nothing"
# ---------------------------------------------------------------------------
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
for volume in "${PROJECT}_paxflux_data" "${PROJECT}_paxflux_backups"; do
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
  docker volume inspect "$volume" >/dev/null 2>&1 && fail "volume ${volume} still exists before the install"
done
ok "no data volume, no backup volume, no container"

prepare_image

# ---------------------------------------------------------------------------
log "§6.2 — the documented quickstart: docker compose up -d"
# ---------------------------------------------------------------------------
"${COMPOSE[@]}" up -d
ok "compose stack started on port ${PAXFLUX_PORT}"

ELAPSED=$(wait_healthy)
ok "container healthy after ${ELAPSED}s"

for volume in "${PROJECT}_paxflux_data" "${PROJECT}_paxflux_backups"; do
  docker volume inspect "$volume" >/dev/null 2>&1 || fail "compose did not create ${volume}"
done
ok "named volumes created: paxflux_data, paxflux_backups"

# ---------------------------------------------------------------------------
log "§6.3 — the operator can reach the app and find the setup token"
# ---------------------------------------------------------------------------
[ "$(api GET /health/ready)" = "200" ] || fail "GET /health/ready did not answer 200"
[ "$(api GET /health/live)" = "200" ]  || fail "GET /health/live did not answer 200"
ok "health endpoints answer"

status=$(curl -s -o "${WORK_DIR}/root.html" -w '%{http_code}' --max-time 20 "${BASE_URL}/")
[ "$status" = "200" ] || fail "GET / returned ${status}"
grep -qi '<div id="root"' "${WORK_DIR}/root.html" || fail "GET / did not return the SPA shell"
ok "frontend served at /"

status=$(curl -s -o "${WORK_DIR}/setup.html" -w '%{http_code}' --max-time 20 "${BASE_URL}/setup")
[ "$status" = "200" ] || fail "GET /setup returned ${status}"
grep -qi '<div id="root"' "${WORK_DIR}/setup.html" || fail "/setup is not served"
ok "/setup reachable"

# Both documented retrieval paths must actually work.
LOG_TOKEN=$("${COMPOSE[@]}" logs paxflux 2>&1 | grep -oE 'Setup Token: [a-f0-9]{64}' | head -1 | awk '{print $3}')
[ -n "$LOG_TOKEN" ] || fail "the README's 'docker compose logs paxflux | grep \"Setup Token\"' found nothing"
ok "setup token readable from the container logs"

CONTAINER=$("${COMPOSE[@]}" ps -q paxflux)
FILE_TOKEN=$(docker exec "$CONTAINER" sh -c 'cat /data/setup-token.txt' | grep -oE '^[a-f0-9]{64}$' | head -1)
[ -n "$FILE_TOKEN" ] || fail "/data/setup-token.txt does not contain a token"
[ "$FILE_TOKEN" = "$LOG_TOKEN" ] || fail "the logged token and /data/setup-token.txt disagree"
TOKEN_PERMS=$(docker exec "$CONTAINER" sh -c 'stat -c %a /data/setup-token.txt')
[ "$TOKEN_PERMS" = "600" ] || fail "setup-token.txt is mode ${TOKEN_PERMS}, expected 600"
ok "setup token also at /data/setup-token.txt, mode 600, same value"

# ---------------------------------------------------------------------------
log "§6.4 — first configuration is completable"
# ---------------------------------------------------------------------------
CSRF_TOKEN=""
code=$(api POST /api/v1/setup "{\"setupToken\":\"${LOG_TOKEN}\",\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\",\"instanceName\":\"PaxFlux Acceptance\"}")
[ "$code" = "200" ] || [ "$code" = "201" ] || fail "/api/v1/setup returned ${code}: $(cat "${WORK_DIR}/body.json")"
CSRF_TOKEN=$(jqf "d['csrfToken']")
ok "first administrator created through the documented flow"

code=$(api POST /api/v1/events '{"name":"Acceptance Compose","capacity":300,"warningRatio1":0.8,"warningRatio2":0.9,"timezone":"Europe/Paris"}')
[ "$code" = "200" ] || [ "$code" = "201" ] || fail "event creation returned ${code}: $(cat "${WORK_DIR}/body.json")"
EVENT_ID=$(jqf "d['id']")

api GET "/api/v1/events/${EVENT_ID}/spaces" >/dev/null
EXTERNAL_ID=$(jqf "[s['id'] for s in d if s['kind']=='external'][0]")
SITE_ID=$(jqf "[s['id'] for s in d if s['kind']=='leaf'][0]")

code=$(api POST "/api/v1/events/${EVENT_ID}/checkpoints" "{\"name\":\"Porte Principale\",\"spaceAId\":\"${EXTERNAL_ID}\",\"spaceBId\":\"${SITE_ID}\",\"allowAToB\":true,\"allowBToA\":true,\"labelAToB\":\"ENTREE\",\"labelBToA\":\"SORTIE\"}")
[ "$code" = "200" ] || [ "$code" = "201" ] || fail "checkpoint creation returned ${code}"
CHECKPOINT_ID=$(jqf "d['id']")

code=$(api POST "/api/v1/events/${EVENT_ID}/start")
[ "$code" = "200" ] || fail "starting the event returned ${code}: $(cat "${WORK_DIR}/body.json")"
ok "event created, topology configured, event live"

# A supervisor adjustment is a real movement, written through the public API.
record_occupancy() { # target
  code=$(api POST "/api/v1/events/${EVENT_ID}/adjustments" "{\"spaceId\":\"${SITE_ID}\",\"observedCount\":$1,\"reason\":\"Comptage acceptance Phase 10\"}")
  [ "$code" = "200" ] || [ "$code" = "201" ] || fail "adjustment returned ${code}: $(cat "${WORK_DIR}/body.json")"
}
read_state() {
  api GET "/api/v1/events/${EVENT_ID}/state" >/dev/null
  jqf "d['occupancy']['global']"
}
count_movements() {
  api GET "/api/v1/events/${EVENT_ID}/export/event.json" >/dev/null
  jqf "len(d['movements'])"
}

record_occupancy 42
SNAPSHOT_OCCUPANCY=$(read_state)
SNAPSHOT_MOVEMENTS=$(count_movements)
[ "$SNAPSHOT_OCCUPANCY" = "42" ] || fail "expected occupancy 42, got ${SNAPSHOT_OCCUPANCY}"
ok "recorded state: occupancy=${SNAPSHOT_OCCUPANCY}, ledger=${SNAPSHOT_MOVEMENTS} movements"

# ---------------------------------------------------------------------------
log "§4 — restart with the same volumes: nothing is recreated, nothing is lost"
# ---------------------------------------------------------------------------
"${COMPOSE[@]}" restart paxflux >/dev/null
RESTART_ELAPSED=$(wait_healthy)
ok "container healthy again after ${RESTART_ELAPSED}s"

[ "$(api GET /health/ready)" = "200" ] || fail "/health/ready is not green after restart"
status=$(curl -s -o "${WORK_DIR}/root2.html" -w '%{http_code}' --max-time 20 "${BASE_URL}/")
[ "$status" = "200" ] && grep -qi '<div id="root"' "${WORK_DIR}/root2.html" || fail "frontend is not served after restart"
ok "health ready and frontend available after restart"

# The restart invalidates nothing by design, but the session cookie belongs to
# a database row: log in again only if the old cookie stopped working.
api GET "/api/v1/events/${EVENT_ID}/state" >/dev/null || true
code=$(api GET "/api/v1/events/${EVENT_ID}/state")
if [ "$code" != "200" ]; then
  CSRF_TOKEN=""
  code=$(api POST /api/v1/auth/login "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}")
  [ "$code" = "200" ] || fail "cannot log in after restart (${code})"
  CSRF_TOKEN=$(jqf "d['csrfToken']")
fi

api GET "/api/v1/events" >/dev/null
FOUND_EVENT=$(jqf "[e['name'] for e in d if e['id']=='${EVENT_ID}']")
[ "$FOUND_EVENT" = "['Acceptance Compose']" ] || fail "the event did not survive the restart: ${FOUND_EVENT}"
api GET "/api/v1/events/${EVENT_ID}" >/dev/null
AFTER_STATUS=$(jqf "d['status']")
[ "$AFTER_STATUS" = "live" ] || fail "event status after restart is ${AFTER_STATUS}, expected live"

AFTER_OCCUPANCY=$(read_state)
AFTER_MOVEMENTS=$(count_movements)
[ "$AFTER_OCCUPANCY" = "$SNAPSHOT_OCCUPANCY" ] || fail "occupancy changed across restart: ${SNAPSHOT_OCCUPANCY} -> ${AFTER_OCCUPANCY}"
[ "$AFTER_MOVEMENTS" = "$SNAPSHOT_MOVEMENTS" ] || fail "ledger changed across restart: ${SNAPSHOT_MOVEMENTS} -> ${AFTER_MOVEMENTS}"
ok "database, event, status, ledger and occupancy all recovered unchanged"

# Migrations must be idempotent: a second boot may not re-apply them.
APPLIED=$(docker exec "$CONTAINER" sh -c 'ls /data' | tr '\n' ' ')
info "/data contains: ${APPLIED}"
"${COMPOSE[@]}" logs paxflux 2>&1 | grep -qiE 'migration failed|already exists|SQLITE_ERROR' \
  && fail "the second boot reported a migration error" || true
ok "migrations are idempotent across restarts"

# ---------------------------------------------------------------------------
log "§5 — backup, divergence, restore by the supported runbook"
# ---------------------------------------------------------------------------
code=$(api POST /api/v1/system/backups '{"reason":"acceptance_phase10"}')
[ "$code" = "201" ] || fail "POST /api/v1/system/backups returned ${code}: $(cat "${WORK_DIR}/body.json")"
BACKUP_FILE=$(jqf "d['filename']")
BACKUP_SHA=$(jqf "d['sha256']")
BACKUP_QUICKCHECK=$(jqf "d['quickCheckOk']")
[ "$BACKUP_QUICKCHECK" = "True" ] || fail "the backup failed its own PRAGMA quick_check"
docker exec "$CONTAINER" sh -c "test -f /backups/${BACKUP_FILE}" || fail "the backup file is not in /backups"
ok "snapshot ${BACKUP_FILE} taken (quick_check ok, sha256 ${BACKUP_SHA:0:16}...)"

# The database must move on after the snapshot, so a restore is observable.
record_occupancy 137
DIVERGED_OCCUPANCY=$(read_state)
DIVERGED_MOVEMENTS=$(count_movements)
[ "$DIVERGED_OCCUPANCY" = "137" ] || fail "expected the diverged occupancy to be 137"
[ "$DIVERGED_MOVEMENTS" -gt "$SNAPSHOT_MOVEMENTS" ] || fail "the ledger did not grow after the snapshot"
ok "database diverged after the snapshot: occupancy=${DIVERGED_OCCUPANCY}, ledger=${DIVERGED_MOVEMENTS}"

log "§5.2 — restore following the runbook exactly"
"${COMPOSE[@]}" stop paxflux >/dev/null
ok "container stopped"

# Restoring means putting the snapshot in place of the live database. Two
# details the first version of the README left out, both of which produce a
# crash-looping container rather than a restored one:
#
#   * the WAL and shared-memory sidecars belong to the *replaced* database, so
#     leaving them behind hands SQLite a journal that does not describe the
#     file beside it;
#   * whatever performs the copy is almost certainly root (a helper container,
#     `docker cp`, a host shell), while PaxFlux runs as uid 10001. A
#     root-owned app.db makes the server die at boot with
#     "attempt to write a readonly database".
docker run --rm \
  -v "${PROJECT}_paxflux_data:/data" \
  -v "${PROJECT}_paxflux_backups:/backups" \
  alpine:3 sh -c "cp /backups/${BACKUP_FILE} /data/app.db \
    && rm -f /data/app.db-wal /data/app.db-shm \
    && chown 10001:10001 /data/app.db \
    && chmod 640 /data/app.db" \
  || fail "could not put the snapshot in place"
ok "snapshot copied over /data/app.db, stale -wal/-shm removed, ownership restored to 10001:10001"

"${COMPOSE[@]}" start paxflux >/dev/null
RESTORE_ELAPSED=$(wait_healthy)
CONTAINER=$("${COMPOSE[@]}" ps -q paxflux)
ok "container healthy again after ${RESTORE_ELAPSED}s"

QUICK_CHECK=$(docker exec "$CONTAINER" sh -c 'node -e "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(\"/data/app.db\");console.log(d.prepare(\"PRAGMA quick_check;\").get().quick_check);d.close();"')
[ "$QUICK_CHECK" = "ok" ] || fail "PRAGMA quick_check on the restored database returned '${QUICK_CHECK}'"
ok "restored database passes PRAGMA quick_check"

# §5.8 — the runbook promises that a restore invalidates the sessions that
# were open before it. Check the promise, using the cookie taken before the
# restore, and do not soften the result either way.
RESTORE_SESSION_CODE=$(api GET "/api/v1/events/${EVENT_ID}/state")
if [ "$RESTORE_SESSION_CODE" = "200" ]; then
  SESSION_SURVIVED=1
  info "a staff session opened before the restore is STILL VALID (HTTP 200)"
else
  SESSION_SURVIVED=0
  ok "staff sessions opened before the restore are rejected (HTTP ${RESTORE_SESSION_CODE})"
fi

CSRF_TOKEN=""
rm -f "$COOKIE_JAR"
code=$(api POST /api/v1/auth/login "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}")
[ "$code" = "200" ] || fail "cannot log in after the restore (${code})"
CSRF_TOKEN=$(jqf "d['csrfToken']")

RESTORED_OCCUPANCY=$(read_state)
RESTORED_MOVEMENTS=$(count_movements)
[ "$RESTORED_OCCUPANCY" = "$SNAPSHOT_OCCUPANCY" ] \
  || fail "restore did not return to the snapshot: expected occupancy ${SNAPSHOT_OCCUPANCY}, got ${RESTORED_OCCUPANCY}"
[ "$RESTORED_MOVEMENTS" = "$SNAPSHOT_MOVEMENTS" ] \
  || fail "restore did not return to the snapshot ledger: expected ${SNAPSHOT_MOVEMENTS}, got ${RESTORED_MOVEMENTS}"
ok "state is exactly the snapshot again: occupancy=${RESTORED_OCCUPANCY}, ledger=${RESTORED_MOVEMENTS}"

status=$(curl -s -o "${WORK_DIR}/root3.html" -w '%{http_code}' --max-time 20 "${BASE_URL}/")
[ "$status" = "200" ] && grep -qi '<div id="root"' "${WORK_DIR}/root3.html" || fail "frontend is not served after the restore"
ok "frontend still served after the restore"

log "Docker Compose acceptance PASSED"
printf '    healthy: first boot %ss, restart %ss, restore %ss\n' "$ELAPSED" "$RESTART_ELAPSED" "$RESTORE_ELAPSED"
if [ "$SESSION_SURVIVED" = "1" ]; then
  printf '\n\033[33m    NOTE: a pre-restore staff session still authenticated after the restore.\n'
  printf '    The file-copy runbook does not pass through restoreDatabaseFromFile(),\n'
  printf '    which is where session invalidation lives. See docs/ACCEPTANCE_REPORT.md.\033[0m\n'
fi
