# ADR-001: Modular Monolith Architecture

> **Correction (2026-09-01).** This ADR names `better-sqlite3`. The shipped
> implementation uses Node 24's built-in `node:sqlite` (`DatabaseSync`);
> `better-sqlite3` is not and has never been a dependency of this
> repository. The decision — embedded SQLite in WAL mode on local disk —
> stands; only the driver name was wrong. See `docs/DEPENDENCIES.md`.


## Status
Accepted

## Context
PaxFlux is designed for events and venues with concurrent counting across multiple mobile devices, live supervisor dashboards, and local administration. The first deployment target is operated by a small, non-technical team without dedicated on-site infrastructure engineers.
Operating distributed systems (microservices, separate frontend servers, separate cache servers, or separate database instances) introduces operational fragility, multi-container synchronization hazards, complex network configuration, and failure modes that jeopardize reliability during a live event.

## Decision
PaxFlux will be implemented as a **single modular monolith process** running inside a single container:
1. **Backend Engine:** Node.js 24 LTS running Fastify 5.
2. **Database:** Embedded SQLite (`node:sqlite`) in WAL mode stored on local disk (`/data/app.db`).
3. **Frontend Delivery:** Static React/Vite PWA SPA bundle served directly by the Fastify backend via `@fastify/static`.
4. **Single Port / Single Container:** The entire application exposes exactly one HTTP/HTTPS port (default 3000) for API endpoints, SSE streams, and static assets.

## Consequences
### Positive
- One-command deployment (`docker run` / `docker compose up -d`).
- No network partition risks between application, database, and cache.
- Minimal RAM and CPU footprint (runs comfortably on 1 vCPU / 512MB RAM).
- Zero external database provisioning or cloud subscription required.
- Coherent, unified backup and restore workflows.

### Negative
- Horizontal scaling across multiple container instances is not supported (vertical scaling is more than sufficient for the target load of 50+ concurrent devices and ~100 req/s bursts).
