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
│   ├── integration/      # Invariant validation, auth, counting, exports, backups
│   ├── load/             # High-throughput load benchmark (50 simulated devices)
│   └── chaos/            # Process crash recovery & ledger reconstruction
└── Dockerfile            # Multi-stage production container
```

---

## Testing & Verification

Run the entire test suite across all packages:

```bash
# Clean install dependencies
npm ci

# Run all test suites (unit, integration, load, chaos)
npx vitest run

# Build all workspaces
npm run build
```

### End-to-end tests (Playwright)

`tests/e2e/` holds a separate Playwright suite (excluded from the vitest run
above via `vitest.config.ts`) driving the app through a real browser against
the built single-process server. Install the managed browser once per
machine, then run the suite:

```bash
# One-time local setup: installs Playwright's managed Chromium build
npx playwright install chromium

# Builds all workspaces and runs the suite (see playwright.config.ts)
npm run test:e2e
```

---

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

```bash
# Trigger an immediate WAL-consistent snapshot from host
docker compose exec paxflux wget -qO- --post-data='{"reason":"manual_cli"}' http://127.0.0.1:3000/api/v1/system/backups
```

### Restoring from Backup

1. Stop the application container:
   
   ```bash
   docker compose stop paxflux
   ```
2. Replace `/data/app.db` with your backup copy.
3. Start the container:
   
   ```bash
   docker compose start paxflux
   ```
   
   *Note: Restoration automatically invalidates all active staff and counter device sessions to prevent stale write collisions.*

---

## License

Apache-2.0. See [LICENSE](LICENSE) for the full text.