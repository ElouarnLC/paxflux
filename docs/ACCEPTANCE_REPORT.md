# PaxFlux — Phase 10 Acceptance Report

**Date**: 2026-09-01
**Verdict**: **ACCEPTED WITH KNOWN LIMITATIONS** — see §10.
**Baseline**: `main @ 126ef29c4118a5f4e194e4dab09e19a939c01e65` (Phase 9 merge, CI run #39 green)
**Branch under acceptance**: `remediation/phase-10-acceptance`
**Specification**: `PaxFlux_SPECIFICATION_v1.1.md`
**Remediation history**: `PaxFlux_REMEDIATION_PLAN_v1.2.md` (historical, phases 1–10)

> This report replaces the document of 2026-08-29, which certified
> "ACCEPTED & READY FOR PRODUCTION" on the basis of 26 tests against the
> pre-remediation alpha. Every figure in it predated the nine remediation
> phases and none of it should be read as a current statement. Nothing from it
> is carried forward here; every number below was measured on the branch this
> report covers.

---

## 1. What was asked, and what was measured

Phase 10 answers one question: *can a non-technical operator install PaxFlux on
a clean machine, prepare a real event, pair several phones, count with and
without network, close the event cleanly, export, and recover a coherent
installation after a restart or a restore?*

The answer is yes, with four limitations recorded in §10 — one of which is a
gap in a recovery guarantee the product previously claimed to offer, and which
is escalated rather than closed here.

---

## 2. Environment

| | |
|---|---|
| OS | Linux 6.18.44 (x86_64) |
| Node (local validation) | v22.22.2 |
| Node (CI and container) | 24.x — `engines.node >= 24.0.0`, `node:24-alpine` |
| npm | 10.9.7 |
| Docker | 29.3.1 |
| Docker Compose | 5.1.1 |
| Playwright | 1.62.1, Chromium |
| Biome | 2.5.11 |

The local Node version differs from the target: this machine has 22.22.2 while
CI and the shipped image run 24. Every result below was therefore also produced
by CI on Node 24, and the packaging results come from the container itself.
Where the two could disagree, CI is the authority.

---

## 3. Quality gates

All from a clean checkout — `node_modules`, every `dist`, and the E2E data
directories removed, then `npm ci`.

| Gate | Command | Result |
|---|---|---|
| Install | `npm ci` | green |
| Types | `npm run typecheck` | green, 3 workspaces |
| Lint | `npm run lint` | **0 diagnostics** |
| Unit / integration | `npm test` | **229 / 229** |
| Build | `npm run build` | green |
| Browser | `npm run test:e2e` | **229 / 229** across 8 viewport projects |

Vitest grew from the Phase 9 baseline of 194 by 35 repository- and
deployment-contract tests (§6). Playwright grew from 221 by the 8 steps of the
operator acceptance scenario. No existing test was removed, skipped, weakened,
retried or made conditional.

---

## 4. Operator acceptance scenario

`tests/e2e/operator-acceptance.spec.ts`, eight ordered steps, on an instance
nobody has touched. It runs against its own server (port 4311, its own data and
backup directories, wiped by `pretest:e2e`) because the shared E2E instance has
its administrator created before any spec runs — a first-run flow that cannot
observe first run proves nothing.

Reference topology: spaces **Extérieur**, **Site**, **VIP**; doors **Porte A**,
**Porte B**, **Porte C** on the Extérieur⇄Site boundary and **Accès VIP** as the
internal Site⇄VIP transfer.

| Step | Verified | Result |
|---|---|---|
| A. First run | uninitialised instance; one setup token, via logs and `/data/setup-token.txt`; first admin created at `/setup`; token then dead; no pre-existing events | pass |
| B. Event setup | 3 spaces and 4 doors through the wizard, endpoints asserted; stays `draft` after save; survives a full page reload; preflight `ready`; counting opens only on an explicit start | pass |
| C. Multi-device | 3 QR invitations with distinct single-use secrets; 3 separate browser contexts paired; all visible to the supervisor on the right doors; online on heartbeats alone with 0 movements created | pass |
| D. Live counting | 3 near-simultaneous tap pairs on two doors → authoritative total 6, nothing lost to the race; internal transfer → Site −1, VIP +1, **global gauge unchanged** | pass |
| E. Offline | real network cut; 4 taps held locally and shown pending; nothing reaching the server; a second phone counting for real meanwhile; automatic drain on reconnect; every tap applied **exactly once** (the total then holds still) | pass |
| F. Undo | visible count returns; the ledger **grows** rather than shrinks — a correction is a compensating movement, never a deletion | pass |
| G. Closing | new counts refused immediately; normal close refused `409 DEVICES_NOT_SYNCED` while a device has not drained; an action created **before** closing still drains afterwards; normal close then succeeds without force | pass |
| H. Closed / export | counter creates nothing, server refuses directly; CSV non-empty, names all doors, row count equals the JSON movement count; JSON carries the event, 3 spaces, 4 checkpoints; **replaying the exported ledger reproduces the reported occupancy**; reopen refused without a reason, accepted with one | pass |

---

## 5. Packaging, fresh install and recovery

### 5.1 Image — `scripts/docker-smoke.sh`

Builds the shipped `Dockerfile` (no CI-only variant) and boots it once on
brand-new volumes.

| Check | Result |
|---|---|
| Image builds | green |
| Container stays up | yes |
| Image `HEALTHCHECK` reaches healthy | **6 s** |
| `GET /health/live` | 200 `{"status":"ok"}` |
| `GET /health/ready` | 200 `{"status":"ready"}` — SQLite opened and migrated on a virgin volume |
| Frontend served | 200, SPA shell |
| Runtime identity | `uid=10001(paxflux) gid=10001(paxflux)`, asserted for the container **and** for the node server process |

### 5.2 Published quickstart — `scripts/acceptance-compose.sh`

`docker compose up -d` from a machine with no `node_modules`, no `dist`, no
data and no backups.

| Check | Result |
|---|---|
| Stack healthy | **6 s** |
| `paxflux_data` and `paxflux_backups` created | yes |
| `/health/live`, `/health/ready`, `/`, `/setup` | all answer |
| Setup token from `docker compose logs paxflux \| grep "Setup Token"` | found |
| Setup token from `/data/setup-token.txt` | same value, mode `600` |
| First configuration completable | admin, event, topology, live, movements |

### 5.3 Restart and persistence (§4)

`docker compose restart` with the same volumes.

| Check | Result |
|---|---|
| Healthy again | **6 s** |
| Database recovered | yes |
| Event, `live` status recovered | yes |
| Ledger length unchanged | yes |
| Occupancy unchanged | yes |
| Migrations idempotent on second boot | no error reported |
| Frontend and `/health/ready` | green |

Nothing was recreated after the reboot: the assertions compare against values
recorded before it.

### 5.4 Backup and restore (§5)

| Check | Result |
|---|---|
| Snapshot via `POST /api/v1/system/backups` | 201, file present in `/backups` |
| Snapshot `PRAGMA quick_check` | ok |
| SHA-256 recorded | yes |
| Database diverged after the snapshot | yes (occupancy 42 → 137) |
| Restore returns to the snapshot exactly | occupancy **42**, ledger length identical |
| `PRAGMA quick_check` on the restored file | ok |
| Frontend after restore | 200 |
| Pre-restore staff sessions invalidated | **no** — see §10.1 |

---

## 6. Contract tests added

| File | Tests | Pins |
|---|---|---|
| `tests/integration/monorepo-contract.test.ts` | 14 | every public command that reaches a workspace importing `@paxflux/shared` builds it first; licence coherent across `LICENSE`, four manifests and the README |
| `tests/integration/deployment-contract.test.ts` | 21 | the `PUBLIC_BASE_URL` / QR contract in both modes; eleven path-traversal spellings refused by the static server; database and setup token never served; API 404s stay RFC 7807 |

---

## 7. Dependency audit

`npm audit` before: **6** (4 moderate, 2 high). After: **4 moderate, 0 high**.

| Package | Prod/dev | Severity | Reachable | Action |
|---|---|---|---|---|
| `@fastify/static` `^8.1.1` → `^10.1.3` | production, direct | **high** (GHSA-83w8-p2f5-377r) + 3 moderate | yes — serves the PWA on every deployment | upgraded; the plugin declares `fastify: '5.x'` against the installed 5.12.1. Regression proof in `deployment-contract.test.ts` |
| `drizzle-orm` `^0.39.3` → `^0.45.2` | production, direct | **high** (GHSA-gpj5-g38j-94v9, SQL injection via SQL identifiers) | **no** — no `sql.identifier`, no `sql.raw`, no template-literal SQL, no request-derived table or column name | upgraded anyway: a high in the data layer of a release candidate should not rest on an argument that only holds for today's call sites |
| `drizzle-kit` `^0.30.4` → `^0.31.10` | **dev only** | 4 × moderate via `@esbuild-kit/esm-loader` → `esbuild` | no | **residual.** 0.31.10 is the latest published version and still depends on the deprecated `@esbuild-kit/esm-loader`; no upstream fix exists. Not shipped — the image installs with `npm ci --omit=dev` — and GHSA-67mh-4wv8-2f99 concerns `esbuild`'s dev server, which `drizzle-kit` never starts |

**This is not "0 vulnerabilities".** Four moderate advisories remain, all in the
dev-only `drizzle-kit` chain, all unfixable upstream today.

---

## 8. Licence

Before: README badge and footer said MIT, `package.json` said Apache-2.0, no
`LICENSE` file existed. The owner confirmed **Apache-2.0**. Now: `LICENSE`
carries the verbatim Apache 2.0 text, all four manifests declare `Apache-2.0`,
the README agrees, and a contract test prevents drift.

The copyright line reads `Copyright 2026 ElouarnLC`, taken from the repository
owner. Replace it with a legal name or entity if one applies.

---

## 9. Defects found and fixed during Phase 10

| # | Defect | Impact | Fix |
|---|---|---|---|
| 1 | `npm run dev` and `npm run dev:web` failed on a clean checkout (`Failed to resolve entry for package "@paxflux/shared"`) | no developer could start the app from a fresh clone | `predev*` scripts build the shared package; pinned by contract test |
| 2 | The server died at boot with `Migrations folder not found` whenever its cwd was not the repository root | `npm run dev -w @paxflux/server` never started | migrations located from the module's own path, cwd kept as fallback |
| 3 | RFC 7807 problem details for `/api/v1/*` 404s were registered only when `apps/web/dist` existed | the published API error shape depended on whether the frontend had been built | handler registered unconditionally; verified with and without the bundle |
| 4 | **The documented restore runbook produced a crash-looping container** (`attempt to write a readonly database`) | the recovery path an operator needs at 2 a.m. did not work as written | README corrected: remove `app.db-wal`/`app.db-shm`, `chown 10001:10001`. Proven by `acceptance-compose.sh` |
| 5 | The documented manual-backup command (`wget --post-data`, unauthenticated) could not work — the endpoint requires an admin session and a CSRF token | operators would conclude backups were broken | README replaced with a login-then-request sequence, verified against a live container |
| 6 | Two high-severity advisories in production dependencies | see §7 | upgraded |
| 7 | Licence contradiction, no `LICENSE` file | blocks a public release | see §8 |

---

## 10. Known limitations

### 10.1 A restore does not invalidate pre-existing sessions — **escalated**

**Measured**, not inferred: a staff session opened before a restore still
authenticates afterwards (HTTP 200). The previous README claimed the opposite.

`restoreDatabaseFromFile()` — which runs `PRAGMA quick_check` on the backup and
revokes every active staff and device session — exists and is covered by
integration tests, but **nothing in production reaches it**. There is no restore
endpoint and no restore command, so the only supported path is the file copy,
which bypasses it entirely.

*Impact*: after restoring an older snapshot, a device or operator holding a
session issued after that snapshot can keep writing to the restored database.
On a compromise-driven restore, a stolen session survives the recovery.

*Mitigation today*: revoke device sessions from the admin interface after a
restore, and change the administrator password if the restore followed a
suspected compromise. Both are documented in the README runbook.

*Why it is not fixed here*: exposing the existing function as an operator
command is a new capability, not a repair, and Phase 10's scope explicitly
stops at that line. **This needs an external decision** on the shape of a
supported restore command before it is built.

### 10.2 Four moderate dev-only advisories remain

See §7. No upstream fix exists; not shipped in the production image.

### 10.3 `useExhaustiveDependencies` suppressed in two components

`Dashboard.tsx` and `SystemPanel.tsx` carry per-site suppressions with written
reasons. Real findings; the safe fix is a `useCallback` refactor of the fetch
functions, which is behavioural work outside Phase 9's and Phase 10's scope.

### 10.4 Local validation ran on Node 22

See §2. CI and the container run Node 24 and are green; where they could
disagree, CI is the authority.

---

## 11. Non-negotiable invariants

The 20 invariants of the specification remain enforced, and the Phase 10
scenario exercises the ones an operator can actually observe. Each row below
names where it is verified **in this branch** rather than restating a claim.

| # | Invariant | Verified by |
|---|---|---|
| 1–2 | Single authoritative SQLite database, WAL PRAGMAs | `tests/integration/db.test.ts`; the restore path asserts `quick_check` on the live file |
| 3 | Single Node process serving API and PWA | `docker-smoke.sh` (one container answers `/health/*`, `/api/v1/*` and `/`) |
| 4 | Mutations over HTTP, realtime over SSE | acceptance steps C–E |
| 5–6 | Append-only ledger, state rebuildable from it | acceptance step F (undo appends); step H (replaying the export reproduces the occupancy) |
| 7 | No silent clamping | `tests/integration/ledger-invariants.test.ts` |
| 8 | Idempotent retries via `clientActionId` | acceptance step E (drain applies each tap exactly once) |
| 9 | Reversals reference the original movement | acceptance step F |
| 10 | Adjustments require a reason | `acceptance-compose.sh` records occupancy through the adjustment endpoint with a reason |
| 11–14 | Topology rules, positive capacity | acceptance step B; `tests/integration/ledger-invariants.test.ts` |
| 15 | Topology locked once live | `tests/integration/event-lifecycle.test.ts` |
| 16 | Single-use pairing tokens | acceptance step C (three distinct secrets); `tests/integration/auth.test.ts` |
| 17 | Session invalidation on restore | **see §10.1 — not honoured by the supported restore path** |
| 18 | CSV formula-injection defence | `tests/integration/export.test.ts` |
| 19 | Secret redaction in logs | `apps/server/src/logging/redactor.ts`; the pairing URL is redacted |
| 20 | Strict CSP | `apps/server/src/app.ts`; `deployment-contract.test.ts` pins the static boundary |

---

## 12. Verdict

**ACCEPTED WITH KNOWN LIMITATIONS.**

The reference operator journey works end to end on a virgin instance, the
published install works, and both recovery paths return a coherent
installation. The quality gates are green from a clean checkout and enforced by
CI.

It is not "ACCEPTED" without qualification because §10.1 is a gap in a recovery
guarantee the product previously advertised, and closing it requires a decision
this phase is not entitled to make. It is not "NOT ACCEPTED" because that gap
has a documented mitigation, is not reachable in normal operation, and does not
affect counting correctness.

Deploy with the §10 limitations understood, and resolve §10.1 before the next
release.
