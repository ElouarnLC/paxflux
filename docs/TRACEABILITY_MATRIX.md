# PaxFlux Specification Traceability Matrix

**Specification:** `PaxFlux_SPECIFICATION_v1.1.md`
**Application:** `PaxFlux` (slug: `paxflux`)
**Last reviewed:** RC2-E, against `remediation/rc2-e-field-polish`
**Previously reviewed:** 2026-09-01, against `remediation/phase-10-acceptance`

The `Planned` statuses in this table dated from before the v1.2 remediation and
were never updated as the work landed. They are corrected below. `Implemented`
means the component exists and is covered by a test named in the Verification
column; it does not by itself mean the requirement is fully satisfied — read
`docs/ACCEPTANCE_REPORT.md` Part II §10 for what is still open, and Part I for
the current status of the product.

Rows whose implementation or verification changed during RC2 name the RC2
phase that changed them. The RC2 additions table at the end covers behaviour
the specification does not describe because it was learnt from using
`v1.0.0-rc.1`.

---

| Spec § | Requirement Summary | Implementation Component | Verification Method | Status |
|---|---|---|---|---|
| **§0, §1** | Canonical product identity `PaxFlux`, slug `paxflux`, no coupling to CROUS/Campulsations in generic identifiers | Monorepo packages, Docker config, UI copy | `npm run lint` (Biome) & code inspection | Implemented |
| **§2.1, §4** | 20 domain invariants (conservation of flow, checkpoint boundaries, leaf exclusivity, immuable ledger, capacity overflow recording) | `apps/server/src/domain/*`, Drizzle schema | Unit & SQLite integration tests | Implemented |
| **§5** | Event lifecycle (`draft` → `live` → `closing` → `closed` → `archived`), topology freezing in live, closing drain | `apps/server/src/domain/events.ts`, `apps/server/src/domain/draft-topology.ts` (RC2-C) | State machine unit & integration tests; `tests/e2e/rc2c-draft-editor.spec.ts` (a draft is editable, a live event's topology is locked) | Implemented |
| **§6** | RBAC personas (Counter device session, Supervisor, Admin) with granular permissions | `apps/server/src/auth/*`, routes middleware | RBAC isolation integration tests | Implemented |
| **§7** | First-run setup token bootstrap (hashed storage, printed to log, written to `/data/setup-token.txt`, 24h expiry, auto-invalidation) | `apps/server/src/auth/bootstrap.ts` | Bootstrap integration test | Implemented |
| **§8** | Event wizard (General info, zone models, checkpoints with customizable button labels, topology validation) | `apps/web/src/admin/wizard/*`, topology API; the draft editor replaced the wizard as the way an event is changed before it goes live (RC2-C) | `tests/e2e/wizard-lifecycle.spec.ts`, `tests/e2e/rc2c-creation-form.spec.ts`, `tests/e2e/rc2c-draft-editor.spec.ts` | Implemented |
| **§9** | Pairing via QR with token in URL fragment (`/pair#<secret>`), single-use exchange for HttpOnly device session | `apps/server/src/auth/pairing.ts`, `apps/web/src/counter/PairingPage.tsx`; the completion step replaced the 800ms auto-navigation and carries optional device naming and a vibration diagnostic (RC2-D, RC2-E) | Pairing flow E2E & security tests; `tests/e2e/rc2d-device-naming.spec.ts`, `tests/e2e/rc2e-haptics.spec.ts` | Implemented |
| **§10** | Field counter UI (~120–180px buttons, connection state, occupancy display, instant tactile feedback, Wake Lock) | `apps/web/src/counter/CounterView.tsx`, `apps/web/src/counter/occupancy-truth.ts` and `haptics.ts` (RC2-E) | Mobile viewport Playwright & accessibility audit; `tests/e2e/rc2e-occupancy-truth.spec.ts`, `tests/e2e/mobile-counter-truth.spec.ts` | Implemented |
| **§11** | Counter Undo/Reversal protocol (never-sent, confirmed, and uncertain-ACK cases) | `apps/web/src/offline/outbox.ts`, counting API | Network loss simulation & integration tests | Implemented |
| **§12** | Supervisor live dashboard (Global gauge, capacity alerts, sync quality indicator, per-space breakdown, 5-min flow rates) | `apps/web/src/admin/Dashboard.tsx` (RC2-B: supervision and analytics converge without a reload) | Real-time SSE integration & E2E tests; `tests/e2e/rc2b-live-supervision.spec.ts` | Implemented |
| **§13** | Supervisor adjustments with mandatory justification reason and immutable audit recording | `apps/server/src/domain/movements.ts` | Adjustment transaction tests | Implemented |
| **§14** | CSV/JSON exports with formula injection neutralization (`=,+,-,@`) | `apps/server/src/routes/export.ts` | CSV injection unit & snapshot tests | Implemented |
| **§15, §16**| Fastify 5 + Node 24 LTS + SQLite WAL + `synchronous=FULL` + single connection + PRAGMAs | `apps/server/src/db/index.ts` | SQLite PRAGMA integration tests | Implemented |
| **§17, §18**| Complete logical schema and essential indexes / unique constraints | `apps/server/src/db/schema.ts`, Drizzle migrations | Drizzle schema & migration tests | Implemented |
| **§19, §20**| Transactional counting algorithm and batch synchronization endpoint with idempotency | `apps/server/src/routes/counting.ts` | Idempotency & batch atomicity tests | Implemented |
| **§21** | Offline-first IndexedDB outbox, optimistic projection, exponential backoff retry | `apps/web/src/offline/*` | Multi-context offline Playwright tests | Implemented |
| **§22** | Controlled PWA service worker, no-live-reload policy, no caching of write APIs | Generated by `vite-plugin-pwa` from `apps/web/vite.config.ts` — there is no hand-written `apps/web/sw.ts`. `registerType: 'prompt'`, `NetworkOnly` for `/api/` and `/health/`, both excluded from the navigation fallback | PWA caching & update tests; `tests/e2e/rc2d-root-launch.spec.ts` reads the built `manifest.webmanifest` and asserts the launch contract | Implemented |
| **§23** | Real-time SSE streaming, post-COMMIT broadcaster with 50–100ms coalescing, compact snapshots | `apps/server/src/realtime/broadcaster.ts` | SSE load & reconnection tests | Implemented |
| **§24** | Standard HTTP API (`/api/v1/*`), RFC 7807 problem error format | `apps/server/src/routes/*` | HTTP schema validation tests | Implemented |
| **§25, §26**| Stateful sessions in HttpOnly cookies, CSRF synchronizer tokens, Origin/Fetch-Metadata checks | `apps/server/src/auth/*` | Security CSRF/Cookie tests | Implemented |
| **§27, §28**| Security headers, strict CSP (`self`), log redaction, rate limiting | `apps/server/src/app.ts`, `redactor.ts` | Security headers audit & log checks | Implemented |
| **§30** | SQLite Online Backup API, SHA-256 validation, `PRAGMA quick_check`, retention, restore with session invalidation | `apps/server/src/backups/backup-service.ts`, `apps/server/src/db/restore.ts` | Backup & restore verification tests; `scripts/acceptance-compose.sh` proves the documented restore path | Implemented |
| **§31** | Local observability (`/health/live`, `/health/ready`, system status panel) | `apps/server/src/routes/system.ts` | Healthcheck integration tests | Implemented |
| **§32, §33**| Multi-stage Docker container (non-root, persistent `/data` and `/backups`), optional Cloudflare/Caddy docs | `Dockerfile`, `docker-compose.yml` | `scripts/docker-smoke.sh`, `scripts/acceptance-compose.sh` | Implemented |
| **§40, §44**| Load testing (~100 req/s burst, 50 devices, 100 SSE) and chaos/recovery resilience | `tests/load/*`, `tests/chaos/*` | Vitest load simulation & chaos recovery (no autocannon: it is not a dependency of this repository) | Implemented |
| **§48, §49**| Operational runbooks and incident response guide | README.md (Operator Runbooks) | Runbooks executed by `scripts/acceptance-compose.sh` | Partial — no separate `docs/operations.md`; the backup and restore runbooks live in README.md and are both exercised in CI by `scripts/acceptance-compose.sh`. |
| **§53** | 8 Architecture Decision Records (ADR-001 through ADR-008) | `docs/adr/ADR-*.md` | ADR verification | Completed |

---

## Phase 10 additions

| Requirement | Implementation | Verification | Status |
|---|---|---|---|
| Operator journey, first run to export, on a virgin instance | product as a whole | `tests/e2e/operator-acceptance.spec.ts` (8 steps) | Implemented |
| Published Docker Compose install | `docker-compose.yml`, `Dockerfile` | `scripts/acceptance-compose.sh` §6 | Implemented |
| Restart / persistence | `/data` volume, migrations | `scripts/acceptance-compose.sh` §4 | Implemented |
| Backup & restore runbook | `backup-service.ts`, `apps/server/src/db/restore.ts`, README runbook | `scripts/acceptance-compose.sh` §5, `tests/integration/db-restore-cli.test.ts` | Implemented |
| Offline restore command, single documented path (invariant 17) | `npm run db:restore` -> `restoreDatabaseFromFile()` | `scripts/acceptance-compose.sh` §5.2 (staff **and** device session valid before the snapshot both rejected after the restore, on the real compose stack) | Implemented |
| Pairing URL contract (`PUBLIC_BASE_URL` set and unset) | `auth/pairing.ts` | `tests/integration/deployment-contract.test.ts` | Implemented |
| Static-serving boundary | `app.ts`, `@fastify/static` 10.x | `tests/integration/deployment-contract.test.ts` | Implemented |
| Clean-checkout developer commands | root `package.json` pre-scripts | `tests/integration/monorepo-contract.test.ts` | Implemented |
| Licence coherence | `LICENSE`, manifests, README | `tests/integration/monorepo-contract.test.ts` | Implemented |

---

## RC2 additions

Behaviour the specification does not describe, because it was learnt from
running `v1.0.0-rc.1`.

| Requirement | Implementation | Verification | Status |
|---|---|---|---|
| A restored instance and a device that pairs again converge on the restored truth (RC2-A) | `apps/server/src/db/restore.ts`, `apps/web/src/offline/snapshot.ts` | `tests/e2e/rc2-restore-rebaseline.spec.ts` | Implemented |
| Supervision and analytics update without reloading the dashboard (RC2-B) | `apps/web/src/admin/Dashboard.tsx`, SSE broadcaster | `tests/e2e/rc2b-live-supervision.spec.ts`, `tests/e2e/admin-device-sync-refresh.spec.ts` | Implemented |
| A draft event is fully editable — metadata, timezone, topology, directions — and is locked the moment it goes live (RC2-C) | `apps/server/src/domain/draft-topology.ts`, per-event FIFO lock | `tests/e2e/rc2c-draft-editor.spec.ts`, `tests/e2e/rc2c-creation-form.spec.ts` | Implemented |
| The application root sends a paired phone to its counter, offline included, and an unpaired browser to the staff surface (RC2-D) | `apps/web/src/app/root-route.ts` | `tests/e2e/rc2d-root-launch.spec.ts` | Implemented |
| A device has a name of its own, changeable by the operator and by supervision, propagated by heartbeat (RC2-D) | `PATCH /api/v1/device/session`, `apps/web/src/counter/useDeviceHeartbeat.ts` | `tests/e2e/rc2d-device-naming.spec.ts`, `tests/e2e/mobile-device-naming.spec.ts` | Implemented |
| The counter distinguishes what the server holds from what this handset still owes it (RC2-E) | `apps/web/src/counter/occupancy-truth.ts` | `apps/web/src/counter/occupancy-truth.test.ts`, `tests/e2e/rc2e-occupancy-truth.spec.ts` scenarios 2 and 5 | Implemented |
| An incoherent occupancy is reported and never clamped, and an acknowledgement does not move the gauge (ADR-004, RC2-E) | `occupancy-truth.ts`, one Dexie transaction in `offline/outbox.ts`, one live query in `CounterView.tsx` | `tests/e2e/rc2e-occupancy-truth.spec.ts` scenarios 1, 3 and 4 | Implemented |
| Vibration is a diagnostic and counting never depends on it (RC2-E) | `apps/web/src/counter/haptics.ts` | `apps/web/src/counter/haptics.test.ts`, `tests/e2e/rc2e-haptics.spec.ts` | Implemented |
| HTTPS deployment, QR origin contract, SSE and `/api` proxy requirements (RC2-E) | README §3, `Caddyfile`, `docker-compose.caddy.yml`, `auth/pairing.ts` | `tests/integration/deployment-contract.test.ts`; the physical half is `docs/FIELD_ACCEPTANCE_RC2.md` | Documented — physical acceptance **PENDING** |
| Physical field acceptance on real handsets over real HTTPS | — | `docs/FIELD_ACCEPTANCE_RC2.md` | **PENDING** — not performed |
