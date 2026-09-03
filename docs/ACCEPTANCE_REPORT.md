# PaxFlux — Acceptance report

**Current status: READY FOR PHYSICAL RC2 FIELD ACCEPTANCE.**
Not "ready for production", and not "production proven" — see
[Part I §4](#4-physical-field-evidence--pending).

This document has two parts, and the distinction between them is the point:

* **[Part I — RC2](#part-i--rc2)** is the current state of the product: the
  five RC2 remediation phases, the evidence the automated suite produces
  today, and the physical field acceptance that is still **PENDING**.
* **[Part II — Phase 10 (historical, 2026-09-01)](#part-ii--phase-10-acceptance-historical-2026-09-01)**
  is preserved verbatim because its packaging and recovery evidence is still
  the best account of how PaxFlux installs and restores. **Its verdict,
  baseline and test counts are historical.** They were measured on
  `3fcb8d37` (`v1.0.0-rc.1`) and five phases of work have landed since;
  nothing in Part II should be read as a current figure.

---

# Part I — RC2

## 1. What RC2 is

`v1.0.0-rc.1` (`3fcb8d376cd0c88bcd2d63e82e25735bd9a6684c`, Phase 10 merge)
was tagged and then used. RC2 is the answer to what that use revealed: five
scoped remediation phases, each its own branch and pull request, none of them
a rewrite.

The tag is immutable and is not moved by any of this work.

| Phase | Subject | PR | Merged at |
| :--- | :--- | :--- | :--- |
| RC2-A | Restore and client rebaseline: a restored instance and a device that pairs again converge on the restored truth | [#13](https://github.com/ElouarnLC/paxflux/pull/13) | `b5818c9` |
| RC2-B | Live supervision and analytics without reloading the dashboard | [#14](https://github.com/ElouarnLC/paxflux/pull/14) | `4ca5767` |
| RC2-C | Draft editor and topology: an event is fully editable until it goes live, and locked once it is | [#15](https://github.com/ElouarnLC/paxflux/pull/15) | `046cf63` |
| RC2-D | PWA launch contract and device identity: a paired phone reopens as its counter, and can be named | [#16](https://github.com/ElouarnLC/paxflux/pull/16) | `90621ad` |
| RC2-E | Counter truth, no-clamp anomalies, haptic diagnostics, HTTPS and field-acceptance documentation | *this pull request* | *not merged* |

## 2. What RC2-E changed

* The counter states what the server holds and what the handset still owes
  it, instead of presenting the sum as a single confirmed number. Optimistic
  counting is unchanged.
* An incoherent occupancy — negative, or above capacity — is reported in
  words and never clamped, on the counter and in supervision (ADR-004).
* An acknowledgement no longer moves the displayed gauge: the outbox
  deletion and the new authoritative state commit together, and the counter
  reads both from one live query.
* Vibration is a diagnostic (`unsupported` / `accepted` / `refused`) with a
  `Tester la vibration` action on the pairing screen. Counting has never
  depended on it and does not now.
* HTTPS deployment, the QR origin contract and the SSE / `/api` proxy
  requirements are documented in the README.
* `docs/FIELD_ACCEPTANCE_RC2.md` is the physical runbook, and it is
  **PENDING**.

## 3. Current automated evidence

Measured on this pull request's head. **CI on Node 24 is the authority**; the
figures below are read from that run, not from a developer machine.

| | |
| :--- | :--- |
| Head SHA | `e39b449e3e7d933c1426aee78142494c6a519267` |
| CI run | [#33799271689](https://github.com/ElouarnLC/paxflux/actions/runs/33799271689) — all four jobs green |
| `npm run typecheck` | green, 3 workspaces |
| `npm run lint` (Biome) | **0 diagnostics**, 177 files |
| `npm test` (Vitest) | **489 / 489**, 38 files |
| `npm run test:e2e` (Playwright, 8 projects) | **378 / 378** |
| `npm run build` | green |
| Docker image build + fresh-boot smoke | green |
| Compose install → restart → restore | green — a staff session and a device session valid before the snapshot are both rejected after the restore |

Vitest grew from the Phase 10 baseline of 245 to 489 across the five RC2
phases; RC2-E added 40 of them — 20 in `occupancy-truth.test.ts`, 11 in
`haptics.test.ts`, 9 in `docs-contract.test.ts`. Playwright grew from 229 to
378; RC2-E added 32 — the 6 no-clamp scenarios and 5 haptic tests run once on
`functional`, and the 3 counter-truth mobile tests run on each of the 7
viewport projects.

No test was removed, skipped, weakened, retried or made conditional in any
RC2 phase.

## 4. Physical field evidence — PENDING

**No physical acceptance has been performed.** No PaxFlux installation on a
real Android or iOS handset, over a real HTTPS origin, has been observed by
anyone producing this report.

This matters because the things RC2-D and RC2-E are about are precisely the
things a headless Linux runner cannot establish: a browser's own install
prompt, a home-screen launch, a service worker surviving a dead radio, and a
vibration motor.

The runbook is [`docs/FIELD_ACCEPTANCE_RC2.md`](FIELD_ACCEPTANCE_RC2.md).
Until its release gates are marked by the owner, RC2 is **ready for physical
field acceptance** and is not production-proven.

---

# Part II — Phase 10 acceptance (historical, 2026-09-01)

> **Historical.** Everything from here to the end of the document was measured
> on 2026-09-01 against `remediation/phase-10-acceptance`, which became
> `v1.0.0-rc.1`. Its verdict was correct for that commit. Its baselines, its
> test counts (245 Vitest / 229 Playwright) and its environment table are
> **not current** — Part I §3 carries the current figures. It is kept because
> its packaging, restart and restore evidence (§5) remains the most detailed
> account of those paths, and re-running them for RC2 is a CI gate rather than
> a hand-written report.

**Date**: 2026-09-01
**Verdict (historical, for `3fcb8d37`)**: **ACCEPTED** — see §12. No Phase 10 blocker remained; three ordinary limitations are recorded in §10.
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

The answer is yes. Seven defects were found and fixed (§9), including a
restore runbook that produced a crash-looping container and a documented backup
command that could not authenticate. The one gap that could not be closed
without an owner's decision — a restore did not invalidate the sessions the
snapshot carried — was escalated, decided, and is now closed by an offline
`npm run db:restore` command whose behaviour is proved end to end (§5.5). Three
ordinary limitations remain in §10; none is a gap in a guarantee the product
makes.

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
| Unit / integration | `npm test` | **245 / 245** |
| Build | `npm run build` | green |
| Browser | `npm run test:e2e` | **229 / 229** across 8 viewport projects |

Vitest grew from the Phase 9 baseline of 194 by 51: 14 repository-contract,
21 deployment-contract and 16 restore-command tests (§6). `pretest` builds the
shared package **and the server**, because four of those tests execute the
compiled `db:restore` entry point that ships in the image; a missing binary
fails them rather than skipping them. Playwright grew from 221 by the 8 steps of the
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
| Pre-restore staff sessions invalidated | **yes** — HTTP 401, see §5.5 |
| Pre-restore device sessions invalidated | **yes** — HTTP 401, see §5.5 |

### 5.5 Offline restore command — invariant 17, proved

Restoration is an offline operation performed by a one-shot container while the
service is stopped. There is deliberately no HTTP endpoint: a restore replaces
the whole instance and must not be reachable from a request.

```
docker compose stop paxflux
docker compose run --rm --no-deps paxflux npm run db:restore -- /backups/<backup>.db
docker compose start paxflux
```

`npm run db:restore` calls `restoreDatabaseFromFile()`, refactored so the
primitive itself guarantees every property rather than leaving them to a
runbook an operator must remember at 2 a.m.:

| Guarantee | How |
|---|---|
| The snapshot is sound before anything is replaced | `PRAGMA quick_check` on the backup; a corrupt file is refused with the live database untouched |
| The live database is never half-restored | work is staged on a temporary file beside the target and promoted by a single `rename` within one directory, which is atomic. Every failure **before** that rename leaves the existing database *and its journal* exactly as they were — the predecessor's `-wal`/`-shm` are cleared **after** promotion, never before, so no earlier failure can strip a still-live database of its journal |
| Sessions carried by the snapshot are revoked | staff and device sessions revoked **on the staged file**, in a transaction, and re-counted before promotion |
| Stale journal removed | `app.db-wal` and `app.db-shm` of the replaced database are deleted; the staged file is checkpointed with `wal_checkpoint(TRUNCATE)` |
| Ownership is right by construction | the command runs as the image's runtime user, so the file it writes is `uid/gid 10001`, mode `640` — the root-owned-copy trap cannot occur |
| The restored database is sound | `PRAGMA quick_check` again, after the rename |
| Any problem is a failure, reported precisely | every path throws a `RestoreError` naming the step and carrying `promoted`. Before promotion the command exits non-zero saying the existing database is untouched; **after** promotion it says the snapshot is already live, could not be verified, and the service must stay stopped. It never reports the second as the first |

Measured by `scripts/acceptance-compose.sh`, on the real compose stack, in CI:

| Check | Result |
|---|---|
| `docker compose run --rm --no-deps paxflux npm run db:restore -- …` | exit 0 |
| Snapshot validated before replacement | reported by the command |
| Sessions revoked | `revoked 1 staff session(s) and 1 device session(s)` |
| Restored database `PRAGMA quick_check`, from inside the running container | `ok` |
| Restored database ownership and mode | `10001:10001 640` |
| **Staff session valid before the snapshot** | **HTTP 401 after the restore** |
| **Device session paired before the snapshot** | **HTTP 401 after the restore** |
| A fresh login works afterwards | yes — revocation is not a lockout |
| State returns exactly to the snapshot | occupancy 42, ledger identical |
| A corrupt snapshot | refused, non-zero, live database untouched and still healthy |
| Post-promotion failure wording | the compiled command prints `THE SNAPSHOT HAS ALREADY BEEN PROMOTED` and `Leave the service STOPPED`, and never `left untouched` |

Both sessions were created **before** the snapshot, so both were inside it: this
is the case invariant 17 is about.

---

## 6. Contract tests added

| File | Tests | Pins |
|---|---|---|
| `tests/integration/monorepo-contract.test.ts` | 14 | every public command that reaches a workspace importing `@paxflux/shared` builds it first; licence coherent across `LICENSE`, four manifests and the README |
| `tests/integration/db-restore-cli.test.ts` | 16 | the restore primitive's guarantees, its refusals, the pre/post-promotion semantics (target *and its journal* intact before promotion; a post-promotion failure reported as promoted), the argument parser, and the compiled command — whose presence is asserted rather than assumed, so a missing binary fails instead of passing silently |
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
| 8 | **A restore did not invalidate the sessions the snapshot carried**, contradicting invariant 17 and the README | a session issued after the snapshot kept writing to the restored database; on a compromise-driven restore, a stolen session survived recovery | escalated, decided by the owner, then closed: offline `npm run db:restore` command, the single documented restore path, with the guarantees enforced in the primitive. Proved end to end in CI — see §5.5 |

---

## 10. Known limitations

None of these is a gap in a guarantee the product makes. The one that was —
sessions surviving a restore — is closed; see §5.5 and §9 defect 8.

### 10.1 Four moderate dev-only advisories remain

See §7. `drizzle-kit` 0.31.10 is the latest published version and still depends
on the deprecated `@esbuild-kit/esm-loader`; no upstream fix exists. Not shipped
— the image installs with `npm ci --omit=dev` — and the advisory concerns
`esbuild`'s dev server, which `drizzle-kit` never starts.

*Impact*: none at runtime. Revisit when `drizzle-kit` drops the loader.

### 10.2 `useExhaustiveDependencies` suppressed in two components

`Dashboard.tsx` and `SystemPanel.tsx` carry per-site suppressions with written
reasons. Real findings; the safe fix is a `useCallback` refactor of the fetch
functions, which is behavioural work outside Phase 9's and Phase 10's scope.

*Impact*: the components refetch on their current schedule, unchanged from
before the lint existed. No user-visible effect.

### 10.3 Local validation ran on Node 22

See §2. CI and the container run Node 24 and are green; where they could
disagree, CI is the authority.

### 10.4 `offline-round2` "un 401 appareil est terminal" is timing-sensitive

Observed once in eight local full-suite runs, and reproduced deliberately:

| Condition | Result |
|---|---|
| Full suite, local | 7 green / 8 runs |
| Full suite, CI (runs #40, #41, #42) | 3 green / 3 |
| Single spec, `npm run test:e2e` (wiped database) | 2 green / 2 |
| Single spec, `npx playwright test` on a database left by a previous run, machine under container load | 1 green / 3 |

The outbox row stays `sending` instead of reaching `quarantined` inside the
test's 25 s budget. The spec queues a tap against an aborted batch route, so the
action enters exponential backoff before the route is released; when the machine
is loaded, the next attempt can fall outside the poll window.

This is a **Phase 6 spec, unmodified by Phase 10**, and it runs *before* the
Phase 10 acceptance spec in file order, so nothing added here feeds it. It was
left alone rather than "stabilised": no retry was added, no timeout inflated,
no assertion weakened. Changing a previous round's test without having pinned
the cause is how a real regression gets hidden.

*Impact*: none on the product — the behaviour under test (a device 401 is
terminal) is asserted correctly and passes. The risk is a red CI run that costs
a cycle.

*Follow-up*: pin the cause in the retry engine's scheduling rather than the
spec's budget, in a dedicated change.

### 10.5 A restore moves event versions backwards, and a new pairing rebaselines the device

Recorded here because a physical-device dry-run of v1.0.0-rc.1 found it and no
automated Compose test could: those tests exercise a real server rollback but
have no browser, so no IndexedDB survives across it.

A restore rolls the **server** back to an earlier `event.version`. It does not
roll a paired browser back — IndexedDB keeps whatever that device last heard.
So after a restore the same browser can hold a *higher* version than the server
now reports, for the same `eventId`.

The device's freshness ordering (newer `version`, then newer `serverTimeMs`)
is correct within one pairing and was rejecting the restored bootstrap as
stale. The counter therefore kept displaying a pre-restore occupancy while the
dashboard, the server and every new tap agreed on the restored one, and no
reload fixed it because the stale row was the one being read back.

The rule now has an identity boundary: **the authenticated bootstrap that
establishes a new device session is the new local baseline, whatever its
version says.** It applies only to the one response completing a handoff this
device asked for. A refresh for the session already established, a late SSE
frame and a batch response all still go through the ordering, so nothing else
can roll a device backwards.

Two consequences an operator should expect after a restore:

* every device must be paired again with a fresh QR code — that was already
  true, since a restore revokes all sessions (§5.5);
* **pairing again is what re-baselines the device.** No site data needs to be
  cleared, no browser restart is required, and none should be asked for.

Counting intent is not touched by any of this: outbox actions created under the
previous session stay owner-scoped, are quarantined by the existing Phase 6
reconciliation rather than deleted, and are never replayed under the new
session.

Proved by `apps/web/src/offline/snapshot.test.ts` against a real in-memory
IndexedDB, and by `tests/e2e/rc2-restore-rebaseline.spec.ts` in a real browser
against a real server.

### 10.6 A restore signs everyone out

Not a defect — it is the mechanism of invariant 17 — but operators must know
it: after a restore, administrators log in again and every counter device must
be paired again with a fresh QR code. Documented in the README runbook. Budget
a few minutes for re-pairing before restoring during a live event.

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
| 17 | Session invalidation on restore | **PASS** — proved through the documented `npm run db:restore` path: a staff session and a device session valid before the snapshot are both rejected (401) afterwards, on the real compose stack in CI (§5.5). Also covered by `tests/integration/db-restore-cli.test.ts` |
| 18 | CSV formula-injection defence | `tests/integration/export.test.ts` |
| 19 | Secret redaction in logs | `apps/server/src/logging/redactor.ts`; the pairing URL is redacted |
| 20 | Strict CSP | `apps/server/src/app.ts`; `deployment-contract.test.ts` pins the static boundary |

---

## 12. Verdict

**ACCEPTED — for Phase 10, on `3fcb8d37`, on 2026-09-01.** The current status
of the product is in [Part I](#part-i--rc2), which is
*ready for physical RC2 field acceptance*, not accepted for production.

The reference operator journey works end to end on a virgin instance, the
published install works, and both recovery paths return a coherent installation
— the restore now through a command whose guarantees are enforced in code and
proved on the real stack, not left to a runbook. The quality gates are green
from a clean checkout and enforced by CI, including the compose install,
restart and restore.

No Phase 10 blocker remains. The limitations in §10 are ordinary: an unfixable
dev-only advisory chain, two lint suppressions with written reasons, a local
Node version that CI overrides, and one operational consequence of invariant 17
that operators need to plan for rather than avoid.

Deploy with §10.4 understood — a restore signs everyone out — and revisit §10.1
when `drizzle-kit` publishes a fix.

> **Read against RC2.** Five phases have landed since this verdict. Where
> Part II describes behaviour RC2 changed — the draft editor, the PWA root,
> device identity, the counter's presentation of occupancy — Part I is what
> the product does now.
