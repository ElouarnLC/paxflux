# PaxFlux

[![CI Status](https://github.com/ElouarnLC/paxflux/actions/workflows/ci.yml/badge.svg)](https://github.com/ElouarnLC/paxflux/actions)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-24.x%20LTS-brightgreen.svg)](https://nodejs.org/)

**PaxFlux** is an open-source, self-hosted, offline-capable, real-time occupancy and people-flow counting system designed for festivals, venues, cultural events, and temporary spaces.

---

## Key Architecture & Product Principles

- **Zero Cloud Lock-in / Single-Process Monolith**: Single Docker container, single Node.js 24 LTS process, single port (`3000`), single local SQLite database in WAL mode. Zero external database dependencies (no PostgreSQL, Redis, Firebase, Supabase).
- **Append-Only Immutable Ledger**: Every tap, exit, and adjustment is recorded as an immutable movement. Capacity overruns and negative counts are surfaced honestly as anomalies—never clamped or dropped.
- **Offline-First PWA Field Counters**: Counter devices continue counting uninterrupted even during total Wi-Fi or 4G blackouts. Actions are buffered in IndexedDB and automatically synchronized using idempotent batch submissions.
- **Zero-Password QR Invitation Exchange**: Field staff pair smartphones instantly by scanning a QR code with single-use secrets transferred via URL fragments (`/pair#<secret>`) so credentials never appear in server access logs.
- **Strict Real-Time SSE Streaming**: Low-latency Server-Sent Events with 50–100ms coalescing windows, automatic keepalive ping heartbeats, and complete state snapshots immediately upon reconnect.
- **Continuous SQLite Snapshots**: WAL-consistent snapshots via `VACUUM INTO`, automatic SHA-256 integrity hashing, `PRAGMA quick_check` verification, and emergency restoration runbooks.

---

## Quickstart (Docker Compose)

### 1. Run with Docker Compose

```bash
# Clone the repository
git clone https://github.com/ElouarnLC/paxflux.git
cd paxflux

# Start PaxFlux in production mode
docker compose up -d
```

PaxFlux is now listening at `http://localhost:3000`.

### 2. First-Run Setup (`/setup`)

1. Check your container startup logs or read `/data/setup-token.txt` to find the one-time **Setup Token**:
   
   ```bash
   docker compose logs paxflux | grep "Setup Token"
   ```
2. Navigate to `http://localhost:3000/setup` in your browser.
3. Enter the token, choose your administrator username and password (hashed with Argon2id), and submit.

### 3. Production Deployment with Caddy (Automatic HTTPS)

For live events requiring HTTPS and public domain names:

```bash
DOMAIN=counter.yourfestival.org docker compose -f docker-compose.caddy.yml up -d
```

---

## Field Counter Pairing Flow

1. From the **PaxFlux Supervisor Dashboard** (`/admin`), select your active event and click **"Gérer les appareils & QR codes"**.
2. Select the gate / checkpoint (e.g. *Porte Nord*) and click **"Générer le QR Code d'appairage"**.
3. Point any smartphone camera (iOS or Android) at the QR code.
4. The smartphone opens the lightweight PWA at `/pair#<secret>`, exchanges the single-use token for a secure HttpOnly session cookie, and opens the field counter interface.
5. Even if network connectivity drops entirely, field volunteers can continue tapping. Taps are visually acknowledged and queued in the IndexedDB outbox until connectivity is restored.

---

## Monorepo Structure

```
paxflux/
├── apps/
│   ├── server/           # Fastify 5 + node:sqlite + Drizzle ORM + SSE Broadcaster
│   └── web/              # React 19 + Vite 6 + Tailwind CSS v4 + Dexie PWA
├── packages/
│   └── shared/           # Domain schemas, DTOs, RFC 7807 problem details, constants
├── drizzle/              # Committed SQL migrations
├── docs/                 # Architecture Decision Records (ADRs) & Traceability
│   ├── adr/              # ADR-001 through ADR-008
│   ├── IMPLEMENTATION_PLAN.md
│   ├── TRACEABILITY_MATRIX.md
│   ├── DEPENDENCIES.md
│   └── ACCEPTANCE_REPORT.md
├── tests/
│   ├── integration/      # Invariants, auth, counting, exports, backups, contracts
│   ├── e2e/              # Playwright: 8 viewport projects + operator acceptance
│   ├── load/             # High-throughput load benchmark (50 simulated devices)
│   └── chaos/            # Process crash recovery & ledger reconstruction
├── scripts/              # docker-smoke.sh, acceptance-compose.sh
└── Dockerfile            # Multi-stage production container
```

---

## Testing & Verification

Every command below is what CI runs, in the same order. `npm run check` is the
composition of the first four.

```bash
npm ci
npm run typecheck     # all three workspaces
npm run lint          # Biome, lint only — no formatter, no mass rewrite
npm test              # Vitest: integration, load and chaos suites
npm run build         # shared -> server -> web
```

A fresh clone needs nothing else: `packages/shared` is built automatically
before any command that consumes it, so `npm ci && npm run typecheck` works on
a tree that has never been built.

### End-to-end tests (Playwright)

`tests/e2e/` is a separate suite (excluded from the Vitest run via
`vitest.config.ts`) driving the app through a real browser against the built
single-process server, across eight viewport projects from 320x568 to 1280x800.

```bash
npx playwright install chromium   # one-time, per machine
npm run test:e2e                  # rebuilds, wipes E2E data, then runs
```

`npm run test:e2e` includes `tests/e2e/operator-acceptance.spec.ts`, the
end-to-end operator scenario: first run through `/setup` on a virgin instance,
event and topology through the wizard, three paired phones, live counting,
offline counting and drain, undo, closing and export.

### Packaging and recovery

```bash
./scripts/docker-smoke.sh          # builds the shipped Dockerfile, boots it on empty volumes
./scripts/acceptance-compose.sh    # docker compose install, restart, backup/restore
```

Both clean up their containers and volumes on every exit path.

### Development

```bash
npm run dev          # API + built frontend on :3000
npm run dev:web      # Vite dev server on :5173
```

## Environment Variables & Configuration

PaxFlux is configured via environment variables. Defaults are pre-configured for direct local network / LAN usage without requiring external services.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PUBLIC_BASE_URL` | *(none / optional)* | Public HTTPS URL (e.g. `https://counter.yourfestival.org`). When set with `https://`, enables strict HTTPS security headers (CSP `upgrade-insecure-requests`, secure cookie flags) and is used to construct absolute pairing URLs. **Leave unset or empty for direct local HTTP / LAN access.** |
| `PORT` | `3000` | Port on which the HTTP server listens inside the container. |
| `HOST` | `0.0.0.0` | Host binding address. |
| `DATA_DIR` | `./data` (or `/data` in Docker) | Directory storing the persistent SQLite database (`app.db`). |
| `BACKUP_DIR` | `./backups` (or `/backups` in Docker) | Directory storing automated SQLite snapshots and recovery points. |
| `LOG_LEVEL` | `info` | Logging verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). |
| `TRUST_PROXY` | `false` | Enable (`true` or IP list) when running behind a reverse proxy (Caddy, Traefik, Nginx). |
| `BACKUP_INTERVAL_LIVE_MINUTES` | `5` | Periodic snapshot interval during active live event execution. |
| `BACKUP_RETENTION_COUNT` | `300` | Maximum retained snapshot archive count before rotating oldest. |
| `PAIRING_TTL_MINUTES` | `30` | Expiration window for unredeemed checkpoint pairing tokens. |
| `STAFF_SESSION_HOURS` | `12` | Staff/admin authentication session lifetime. |
| `DEVICE_SESSION_GRACE_HOURS` | `24` | Post-event offline sync grace period for field counters. |

---

## Operator Runbooks

### Creating a Manual Backup

Snapshots are taken through the admin API, which requires an authenticated
administrator session and a CSRF token — an unauthenticated `wget` against
this endpoint is rejected with 401. Trigger one from the **État Système**
panel in the admin interface, or from a script that logs in first:

```bash
BASE_URL=http://localhost:3000

# 1. Log in and keep the session cookie; the response carries the CSRF token.
CSRF=$(curl -s -c /tmp/paxflux.jar -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<password>"}' \
  "$BASE_URL/api/v1/auth/login" | python3 -c 'import json,sys;print(json.load(sys.stdin)["csrfToken"])')

# 2. Ask for a WAL-consistent snapshot (VACUUM INTO + SHA-256 + quick_check).
curl -s -b /tmp/paxflux.jar -H 'Content-Type: application/json' \
  -H "x-csrf-token: $CSRF" -H "Origin: $BASE_URL" \
  -d '{"reason":"manual_cli"}' "$BASE_URL/api/v1/system/backups"
```

Snapshots land in `BACKUP_DIR` (`/backups` in Docker) and are listed by
`GET /api/v1/system/backups`. Periodic snapshots are taken automatically while
an event is live, every `BACKUP_INTERVAL_LIVE_MINUTES`.

### Restoring from Backup

Restoration is an **offline** operation performed by a one-shot container while
the service is stopped. `npm run db:restore` is the only supported way to do it:
there is deliberately no HTTP endpoint, because a restore replaces the whole
instance and must not be reachable from a request.

```bash
docker compose stop paxflux
docker compose run --rm --no-deps paxflux npm run db:restore -- /backups/paxflux-backup-<timestamp>-<reason>.db
docker compose start paxflux
```

List the snapshots available on the volume first if you need the filename:

```bash
docker compose run --rm --no-deps paxflux ls -1 /backups
```

The command runs as the image's own runtime user, so everything the old manual
file-copy procedure asked you to remember is enforced rather than documented:

* the snapshot is validated with `PRAGMA quick_check` **before** anything is
  replaced — a corrupt backup can no longer destroy a working instance;
* the work happens on a temporary file and is promoted by a single rename, so
  the live database is never left half-restored;
* **every staff and device session carried by the snapshot is revoked**, so a
  token issued after the snapshot cannot keep writing to the restored database
  (specification invariant 17);
* the stale `app.db-wal` and `app.db-shm` of the replaced database are removed;
* the restored file belongs to the runtime user (uid/gid `10001`, mode `640`)
  by construction, because that user is what writes it;
* the restored database is checked again with `PRAGMA quick_check` before the
  command reports success.

The command exits non-zero on any problem, and tells you which of the two
situations you are in:

* **Failed before promotion** — the snapshot was never put in place. The
  existing database and its journal are exactly as they were, and you can start
  the service again as it was. This covers every refusal above: a bad path, a
  corrupt snapshot, a failure while staging.
* **Failed after promotion** — the rename already happened, so the snapshot *is*
  the database, and the command says so explicitly. **Leave the service
  stopped**, investigate the database in place or restore another snapshot with
  the same command, and only then start again. The command never reports this
  case as "untouched".

The promotion itself is a single `rename` within one directory, which is atomic:
a reader sees either the old database or the new one, never a half-written file.
The predecessor's `-wal` and `-shm` are cleared *after* that rename, never
before, so a failure at any earlier point cannot leave a still-live database
stripped of its journal.

Everyone is signed out after a restore — administrators log in again, and
counter devices must be paired again with a fresh QR code. Pairing again is
also what resets a device's local view: a restore moves the event's version
backwards, and the bootstrap of the new pairing becomes that device's new
authoritative baseline. **Do not ask anyone to clear site data or restart their
browser** — scanning a fresh QR code is the whole procedure. That is intentional:
it is what prevents a session created after the snapshot from writing into the
restored state.

`scripts/acceptance-compose.sh` runs exactly this sequence in CI and asserts
that a staff session and a device session that were valid before the snapshot
are both rejected afterwards.

> **Restoring outside Docker.** The same command works from a checkout:
> `npm run db:restore -- <backup.db> [--target <path-to-app.db>]`. It defaults
> to `$DATA_DIR/app.db`.

## License

Apache-2.0. See [LICENSE](LICENSE) for the full text.