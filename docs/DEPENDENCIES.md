# PaxFlux Dependency Compatibility Record

**Runtime Target:** Node.js 24 LTS (`engines.node >= 24.0.0`; the shipped image is `node:24-alpine`)
**Package Manager:** npm (npm workspaces)
**Last reviewed:** 2026-09-01, against `remediation/phase-10-acceptance`

---

## 1. Backend Core & Plugins

| Package | Purpose | Target Version | Compatibility & Rationale |
|---|---|---|---|
| `fastify` | High-performance HTTP/2 & HTTP/1.1 backend framework | `^5.2.1` | Fastify 5 is natively compatible with Node 24 LTS and TypeScript 5. |
| `@fastify/static` | Serve static frontend PWA assets from single process | `^10.1.3` | Upgraded in Phase 10 to clear a high-severity route-guard bypass (GHSA-83w8-p2f5-377r) and three moderate advisories. Declares `fastify: '5.x'`; the static boundary is pinned by `tests/integration/deployment-contract.test.ts`. |
| `@fastify/cookie` | Parse and sign HttpOnly session cookies | `^11.0.2` | Official Fastify 5 cookie manager supporting secure cookie prefixes. |
| `@fastify/helmet` | Security headers (CSP, HSTS, frame-ancestors, etc.) | `^13.0.1` | Official Fastify 5 security plugin. |
| `@fastify/rate-limit` | Rate limiter by IP / route for brute-force protection | `^10.2.2` | In-memory store for single-instance monolith. |
| `@fastify/cors` | Cross-Origin controls (strictly restricted to same origin) | `^10.0.2` | Same-origin configuration by default. |
| `node:sqlite` | Local SQLite driver with WAL support | Built-in to Node 24 | `DatabaseSync` from the Node standard library. **`better-sqlite3` is not a dependency of this repository** and never has been in the shipped tree — earlier revisions of this document and of ADR-001/ADR-002 named it, which was wrong. |
| `drizzle-orm` | Type-safe SQL query builder and schema manager | `^0.45.2` | Upgraded in Phase 10 to clear GHSA-gpj5-g38j-94v9 (SQL injection via SQL identifiers). Not reachable in this codebase — no `sql.identifier`, `sql.raw`, template-literal SQL or request-derived identifiers — but upgraded rather than argued away. |
| `drizzle-kit` | Migration generation tooling (**dev only**) | `^0.31.10` | Generates deterministic SQL migration files committed to Git. Carries 4 moderate advisories through `@esbuild-kit/esm-loader` -> `esbuild` that **cannot be fixed today**: 0.31.10 is the latest published version and still depends on the deprecated loader. Accepted as a residual — not shipped (`npm ci --omit=dev` in the image) and GHSA-67mh-4wv8-2f99 concerns esbuild's dev server, which drizzle-kit never starts. |
| `@node-rs/argon2` | OWASP-recommended Argon2id password hashing | `^2.2.0` | N-API precompiled native Argon2id bindings with zero runtime build dependencies across Windows, Linux, and macOS. |
| `pino` / `pino-pretty` | Structured JSON logging with custom key redaction | `^9.6.0` | Built-in logger for Fastify. |
| `zod` | Runtime schema validation & DTO parsing | `^3.24.2` | Strict type checking and JSON validation across client/server. |

---

## 2. Frontend Web PWA

| Package | Purpose | Target Version | Compatibility & Rationale |
|---|---|---|---|
| `react` / `react-dom` | UI framework for Counter PWA and Admin Dashboard | `^19.0.0` | Modern, performant reactive UI layer. |
| `react-router-dom` | Client-side routing for SPA | `^7.2.0` | Modern SPA router. |
| `@tanstack/react-query`| Server state management & cache invalidation | `^5.66.7` | Standard for async API data management. |
| `dexie` / `dexie-react-hooks` | IndexedDB wrapper for offline outbox persistence | `^4.0.11` | Robust IndexedDB transaction management with observable hooks. |
| `lucide-react` | Local UI icons (bundled locally, no external CDN) | `^0.475.0` | Clean SVG icon set. |
| `qrcode.react` | Local SVG rendering of QR codes for pairing | `^4.2.0` | Client-side QR generation without external image service. |
| `clsx` / `tailwind-merge` | Utility styling helpers | `^2.1.1` / `^3.0.1` | Utility class merging. |
| `tailwindcss` | Utility-first CSS framework | `^4.0.8` | Modern CSS styling compiled into static CSS. |
| `@tailwindcss/vite` | Vite integration for Tailwind CSS v4 | `^4.0.8` | First-class build pipeline integration. |
| `vite` | Fast frontend build tool & dev server | `^6.1.1` | Native ESM bundler. |
| `vite-plugin-pwa` | PWA manifest & service worker generation | `^0.21.1` | Fine-grained service worker caching without auto-refresh traps. |

---

## 3. Tooling, Testing & DevOps

| Package | Purpose | Target Version |
|---|---|---|
| `typescript` | Static type safety (`strict: true`) | `^5.7.3` |
| `@biomejs/biome` | Lint only — formatter disabled, see `biome.json` | `^2.5.11` |
| `vitest` | Unit and integration test runner | `^3.0.7` |
| `@playwright/test` | End-to-end browser testing (Chromium; 8 viewport projects) | `^1.62.1` |
| `rimraf` / `tsx` | Workspace script helpers | `^6.0.1` / `^4.19.3` |

---

## 4. Security posture

`npm audit` is analysed rather than auto-fixed. As of 2026-09-01:

```
4 moderate, 0 high, 0 critical
```

All four are the dev-only `drizzle-kit` -> `@esbuild-kit/esm-loader` -> `esbuild`
chain described above. **This is not a clean audit and should not be reported as
one.** The production dependency tree — what `npm ci --omit=dev` installs into
the image — carries no known advisory at this date.

Rules for this repository:

* never run `npm audit fix --force` without reading each advisory;
* a production, reachable advisory is fixed before release;
* a residual is recorded here with package, severity, reachability and the
  reason no fix was taken, or it is not a residual — it is an oversight.
