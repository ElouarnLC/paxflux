# PaxFlux Specification Traceability Matrix

**Specification:** `PaxFlux_SPECIFICATION_v1.1.md`  
**Application:** `PaxFlux` (slug: `paxflux`)  

---

| Spec § | Requirement Summary | Implementation Component | Verification Method | Status |
|---|---|---|---|---|
| **§0, §1** | Canonical product identity `PaxFlux`, slug `paxflux`, no coupling to CROUS/Campulsations in generic identifiers | Monorepo packages, Docker config, UI copy | Automated linting & code inspection | Planned |
| **§2.1, §4** | 20 domain invariants (conservation of flow, checkpoint boundaries, leaf exclusivity, immuable ledger, capacity overflow recording) | `apps/server/src/domain/*`, Drizzle schema | Unit & SQLite integration tests | Planned |
| **§5** | Event lifecycle (`draft` → `live` → `closing` → `closed` → `archived`), topology freezing in live, closing drain | `apps/server/src/domain/events.ts` | State machine unit & integration tests | Planned |
| **§6** | RBAC personas (Counter device session, Supervisor, Admin) with granular permissions | `apps/server/src/auth/*`, routes middleware | RBAC isolation integration tests | Planned |
| **§7** | First-run setup token bootstrap (hashed storage, printed to log, written to `/data/setup-token.txt`, 24h expiry, auto-invalidation) | `apps/server/src/auth/bootstrap.ts` | Bootstrap integration test | Planned |
| **§8** | Event wizard (General info, zone models, checkpoints with customizable button labels, topology validation) | `apps/web/src/admin/wizard/*`, topology API | E2E Playwright wizard test | Planned |
| **§9** | Pairing via QR with token in URL fragment (`/pair#<secret>`), single-use exchange for HttpOnly device session | `apps/server/src/auth/pairing.ts`, `apps/web/src/counter/PairingPage.tsx` | Pairing flow E2E & security tests | Planned |
| **§10** | Field counter UI (~120–180px buttons, connection state, occupancy display, instant tactile feedback, Wake Lock) | `apps/web/src/counter/CounterView.tsx` | Mobile viewport Playwright & accessibility audit | Planned |
| **§11** | Counter Undo/Reversal protocol (never-sent, confirmed, and uncertain-ACK cases) | `apps/web/src/offline/outbox.ts`, counting API | Network loss simulation & integration tests | Planned |
| **§12** | Supervisor live dashboard (Global gauge, capacity alerts, sync quality indicator, per-space breakdown, 5-min flow rates) | `apps/web/src/admin/Dashboard.tsx` | Real-time SSE integration & E2E tests | Planned |
| **§13** | Supervisor adjustments with mandatory justification reason and immutable audit recording | `apps/server/src/domain/movements.ts` | Adjustment transaction tests | Planned |
| **§14** | CSV/JSON exports with formula injection neutralization (`=,+,-,@`) | `apps/server/src/routes/export.ts` | CSV injection unit & snapshot tests | Planned |
| **§15, §16**| Fastify 5 + Node 24 LTS + SQLite WAL + `synchronous=FULL` + single connection + PRAGMAs | `apps/server/src/db/index.ts` | SQLite PRAGMA integration tests | Planned |
| **§17, §18**| Complete logical schema and essential indexes / unique constraints | `apps/server/src/db/schema.ts`, Drizzle migrations | Drizzle schema & migration tests | Planned |
| **§19, §20**| Transactional counting algorithm and batch synchronization endpoint with idempotency | `apps/server/src/routes/counting.ts` | Idempotency & batch atomicity tests | Planned |
| **§21** | Offline-first IndexedDB outbox, optimistic projection, exponential backoff retry | `apps/web/src/offline/*` | Multi-context offline Playwright tests | Planned |
| **§22** | Controlled PWA service worker, no-live-reload policy, no caching of write APIs | `apps/web/sw.ts` | PWA caching & update tests | Planned |
| **§23** | Real-time SSE streaming, post-COMMIT broadcaster with 50–100ms coalescing, compact snapshots | `apps/server/src/realtime/broadcaster.ts` | SSE load & reconnection tests | Planned |
| **§24** | Standard HTTP API (`/api/v1/*`), RFC 7807 problem error format | `apps/server/src/routes/*` | HTTP schema validation tests | Planned |
| **§25, §26**| Stateful sessions in HttpOnly cookies, CSRF synchronizer tokens, Origin/Fetch-Metadata checks | `apps/server/src/auth/*` | Security CSRF/Cookie tests | Planned |
| **§27, §28**| Security headers, strict CSP (`self`), log redaction, rate limiting | `apps/server/src/app.ts`, `redactor.ts` | Security headers audit & log checks | Planned |
| **§30** | SQLite Online Backup API, SHA-256 validation, `PRAGMA quick_check`, retention, restore with session invalidation | `apps/server/src/backups/backup-service.ts` | Backup & restore verification tests | Planned |
| **§31** | Local observability (`/health/live`, `/health/ready`, system status panel) | `apps/server/src/routes/system.ts` | Healthcheck integration tests | Planned |
| **§32, §33**| Multi-stage Docker container (non-root, persistent `/data` and `/backups`), optional Cloudflare/Caddy docs | `Dockerfile`, `deploy/docker-compose.yml` | Container build & launch tests | Planned |
| **§40, §44**| Load testing (~100 req/s burst, 50 devices, 100 SSE) and chaos/recovery resilience | `tests/load/*`, `tests/chaos/*` | Autocannon load & recovery test run | Planned |
| **§48, §49**| Operational runbooks and incident response guide | `docs/operations.md` | Documentation review | Planned |
| **§53** | 8 Architecture Decision Records (ADR-001 through ADR-008) | `docs/adr/ADR-*.md` | ADR verification | Completed |
