# PaxFlux Dependency Compatibility Record

**Runtime Target:** Node.js 24 LTS (`v24.13.1` verified)  
**Package Manager:** npm (npm workspaces)  

---

## 1. Backend Core & Plugins

| Package | Purpose | Target Version | Compatibility & Rationale |
|---|---|---|---|
| `fastify` | High-performance HTTP/2 & HTTP/1.1 backend framework | `^5.2.1` | Fastify 5 is natively compatible with Node 24 LTS and TypeScript 5. |
| `@fastify/static` | Serve static frontend PWA assets from single process | `^8.1.1` | Official Fastify 5 plugin. |
| `@fastify/cookie` | Parse and sign HttpOnly session cookies | `^11.0.2` | Official Fastify 5 cookie manager supporting secure cookie prefixes. |
| `@fastify/helmet` | Security headers (CSP, HSTS, frame-ancestors, etc.) | `^13.0.1` | Official Fastify 5 security plugin. |
| `@fastify/rate-limit` | Rate limiter by IP / route for brute-force protection | `^10.2.2` | In-memory store for single-instance monolith. |
| `@fastify/cors` | Cross-Origin controls (strictly restricted to same origin) | `^10.0.2` | Same-origin configuration by default. |
| `node:sqlite` / `better-sqlite3` | High-performance local SQLite driver with WAL support | Built-in (SQLite 3.51.2) | Node 24 LTS includes native `node:sqlite` (`DatabaseSync`), offering identical SQLite 3.51 WAL performance, full ACID transactions, and zero external build toolchain requirements across all host operating systems. |
| `drizzle-orm` | Type-safe SQL query builder and schema manager | `^0.39.3` | Zero-overhead ORM supporting SQLite with typed schemas and migrations. |
| `drizzle-kit` | Migration generation and runner tooling | `^0.30.4` | Generates deterministic SQL migration files committed to Git. |
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
| `vitest` | Unit and integration test runner | `^3.0.7` |
| `@playwright/test` | End-to-end multi-browser context testing | `^1.50.0` |
| `autocannon` | HTTP load and burst testing tool | `^8.0.0` |
| `rimraf` / `tsx` | Workspace script helpers | `^6.0.1` / `^4.19.3` |
