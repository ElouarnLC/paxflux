# PaxFlux Implementation Plan & Delivery Roadmap

**Target Version:** 1.0.0
**Specification Reference:** `PaxFlux_SPECIFICATION_v1.1.md`
**Date:** August 2026

> **Historical document.** This is the plan as written before implementation,
> kept for the record. It is not a description of the current system: it names
> `better-sqlite3` (the shipped code uses Node 24's built-in `node:sqlite`) and
> predates the ten v1.2 remediation phases. For what the system does today read
> `README.md`, `docs/ACCEPTANCE_REPORT.md` and `docs/TRACEABILITY_MATRIX.md`.

---

## 1. Project Invariants & Non-Negotiable Constraints

1. **Topology:** Exactly one application container, one Node.js 24 LTS process, one Fastify 5 server on one port, local SQLite (`node:sqlite`) in WAL mode with `synchronous=FULL` on a persistent `/data` volume.
2. **Zero External Databases/BaaS:** No PostgreSQL, MySQL, Redis, Firebase, Supabase, Airtable, or external SaaS dependencies.
3. **Data Integrity:** Append-only immutable movement ledger (`movements`). The materialized `space_state` is continuously reconstructable from the ledger. Capacity limits trigger visual alarms and anomalies but **never** discard real physical movements or clamp negative counts.
4. **Protocols:** State mutations exclusively via transactional HTTP POST/PATCH endpoints. Real-time updates exclusively via Server-Sent Events (SSE).
5. **Offline-First PWA:** Local actions queued in IndexedDB (`outbox_actions`) with cryptographically strong `client_action_id` UUIDs, optimistic projection, idempotent deduplication, and a multi-state reversal protocol (Undo) that handles uncertain network ACKs safely without data loss.
6. **Security Baseline:** First-run entropy setup token (hashed in DB, printed once to logs and written to `/data/setup-token.txt` with `0600`), Argon2id password hashing, opaque HttpOnly session cookies (`__Host-` in production HTTPS), synchronizer CSRF tokens, fragment-based QR invitation exchange (`/pair#<token>`), strict CSP without external CDNs/fonts, and centralized log redaction.

---

## 2. Monorepo Structure

```text
paxflux/
├── apps/
│   ├── server/                         # Fastify 5 Application
│   │   ├── src/
│   │   │   ├── app.ts                  # Fastify app builder & plugin registration
│   │   │   ├── server.ts               # Process entry point, signal handling
│   │   │   ├── config/                 # Env validation (TypeBox/Zod)
│   │   │   ├── db/
│   │   │   │   ├── index.ts            # node:sqlite connection, PRAGMAs
│   │   │   │   ├── schema.ts           # Drizzle ORM schema definitions
│   │   │   │   ├── migrator.ts         # Migration runner with backup hook
│   │   │   │   └── rebuild.ts          # State reconstruction from ledger
│   │   │   ├── domain/
│   │   │   │   ├── events.ts           # Event lifecycle service
│   │   │   │   ├── spaces.ts           # Space graph & topology validator
│   │   │   │   ├── checkpoints.ts      # Checkpoint domain rules
│   │   │   │   ├── movements.ts        # Counting, reversals, adjustments transaction
│   │   │   │   └── analytics.ts        # Flow rates, peak occupancy, metrics
│   │   │   ├── auth/
│   │   │   │   ├── passwords.ts        # Argon2id password hashing
│   │   │   │   ├── staff-sessions.ts   # Staff session management
│   │   │   │   ├── pairing.ts          # QR invitations and device sessions
│   │   │   │   ├── csrf.ts             # Synchronizer CSRF tokens & Origin checks
│   │   │   │   └── bootstrap.ts        # One-time setup token generator & validator
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts             # /api/v1/auth/* & /api/v1/setup
│   │   │   │   ├── events.ts           # /api/v1/events/*
│   │   │   │   ├── topology.ts         # /api/v1/events/:id/spaces & checkpoints
│   │   │   │   ├── devices.ts          # /api/v1/device/* & device-invites
│   │   │   │   ├── counting.ts         # /api/v1/device/actions/batch & /adjustments
│   │   │   │   ├── export.ts           # /api/v1/events/:id/export/*
│   │   │   │   ├── system.ts           # /api/v1/system/* & /health/*
│   │   │   │   └── sse.ts              # SSE stream endpoints
│   │   │   ├── realtime/
│   │   │   │   └── broadcaster.ts      # Post-COMMIT SSE broadcast & coalescing
│   │   │   ├── backups/
│   │   │   │   └── backup-service.ts   # SQLite backup API, quick_check, retention
│   │   │   ├── logging/
│   │   │   │   └── redactor.ts         # Pino log redactor for sensitive keys
│   │   │   └── cli/
│   │   │       └── index.ts            # Admin CLI (password reset, restore)
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/                            # React + Vite PWA
│       ├── src/
│       │   ├── app/                    # Routing, Layouts, Providers
│       │   ├── counter/                # Field Counter PWA UI & controller
│       │   ├── admin/                  # Dashboard, Wizard, Topology, Analytics, System
│       │   ├── offline/
│       │   │   ├── db.ts               # Dexie IndexedDB (outbox_actions, device_cache)
│       │   │   ├── outbox.ts           # Action queue, optimistic math, sync worker
│       │   │   └── retry.ts            # Exponential backoff retry engine
│       │   ├── api/                    # Typed API client, CSRF header handling
│       │   ├── sse/                    # SSE EventSource listener & state store
│       │   ├── components/             # Reusable UI widgets, badges, buttons, modals
│       │   ├── styles/                 # Tailwind CSS styles & tokens (offline/bundled)
│       │   └── main.tsx
│       ├── public/
│       │   ├── manifest.json           # PWA Manifest
│       │   └── icons/                  # Local PWA icons
│       ├── sw.ts                       # Custom service worker
│       ├── vite.config.ts
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   └── shared/                         # Shared Types, DTOs & Contracts
│       ├── src/
│       │   ├── models.ts               # Domain types (Event, Space, Movement, etc.)
│       │   ├── api-contracts.ts        # Request/Response schemas & DTOs
│       │   ├── offline-protocol.ts     # Outbox action types, batch sync contracts
│       │   ├── realtime-protocol.ts    # SSE message schemas (state, event-status)
│       │   ├── constants.ts            # Default limits, timings, warning ratios
│       │   └── errors.ts               # RFC 7807 problem error codes
│       ├── package.json
│       └── tsconfig.json
├── drizzle/                            # Generated & Committed SQL Migrations
├── docs/
│   ├── IMPLEMENTATION_PLAN.md          # Implementation plan & roadmap
│   ├── ACCEPTANCE_REPORT.md            # Acceptance report & test results
│   ├── DEPENDENCIES.md                 # Dependency compatibility matrix
│   ├── TRACEABILITY_MATRIX.md          # Specification traceability matrix
│   ├── architecture.md                 # System architecture overview
│   ├── operations.md                   # Operator runbook & incident guide
│   ├── security.md                     # Security model & threat analysis
│   ├── deployment.md                   # Docker & reverse-proxy deployment guide
│   └── adr/                            # Architecture Decision Records
├── tests/
│   ├── unit/                           # Domain math, invariants, CSV sanitizer
│   ├── integration/                    # Database, transactions, auth, SSE, backups
│   ├── e2e/                            # Playwright multi-device scenarios
│   ├── load/                           # Autocannon burst & throughput test scripts
│   └── fixtures/                       # Example events & topologies
├── deploy/
│   ├── docker-compose.yml              # Standard production Compose
│   ├── docker-compose.cloudflare.yml.example
│   └── docker-compose.caddy.yml.example
├── Dockerfile                          # Multi-stage production container
├── .dockerignore
├── .env.example
├── package.json                        # Root workspace configuration
├── package-lock.json
├── README.md
├── SECURITY.md
├── CONTRIBUTING.md
└── LICENSE                             # Apache-2.0
```

---

## 3. Phased Execution Roadmap

- **Phase 0:** Planning, ADRs, Dependencies, Traceability
- **Phase 1:** Monorepo Scaffolding & Build System
- **Phase 2:** Database, Migrations & Domain Ledger
- **Phase 3:** Auth, Setup Token, Sessions & QR Pairing
- **Phase 4:** Counting Transaction Engine & Idempotency
- **Phase 5:** Real-time SSE Broadcaster & Snapshot Sync
- **Phase 6:** Field Counter PWA & Offline Outbox Engine
- **Phase 7:** Supervisor/Admin UX, Dashboard & Lifecycle Controls
- **Phase 8:** Exports, SQLite Backups & Recovery Engine
- **Phase 9:** Security Hardening, CSP & Log Redaction
- **Phase 10:** Comprehensive Tests (Unit, Integration, E2E, Load, Chaos)
- **Phase 11:** Packaging, Docker, CI/CD, Documentation & Acceptance Report
