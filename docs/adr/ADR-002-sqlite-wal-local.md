# ADR-002: Embedded SQLite in WAL Mode on Local Storage

> **Correction (2026-09-01).** This ADR names `better-sqlite3`. The shipped
> implementation uses Node 24's built-in `node:sqlite` (`DatabaseSync`);
> `better-sqlite3` is not and has never been a dependency of this
> repository. The decision — embedded SQLite in WAL mode on local disk —
> stands; only the driver name was wrong. See `docs/DEPENDENCIES.md`.


## Status
Accepted

## Context
Event counting requires durable persistence, strict atomicity across space transfers and inventory updates, and fast transactional execution. External RDBMS engines (such as PostgreSQL or MySQL) add operational overhead, network round-trips, separate backup strategies, and connection pool management.
SQLite provides full ACID guarantees, in-process performance, zero network latency, and simple single-file backups.

## Decision
PaxFlux uses local SQLite managed via `node:sqlite` and Drizzle ORM, configured with the following mandatory PRAGMAs on every connection startup:
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Storage rules:
1. The active SQLite database file must reside on local, non-networked persistent storage (`/data/app.db`). NFS, SMB, or distributed network file systems are strictly prohibited for active WAL operations.
2. Backups use `VACUUM INTO` to produce a standalone, fully-checkpointed snapshot without blocking writers or readers.
3. Mutations are serialized within the single Fastify process using short, synchronous transactions.

## Consequences
### Positive
- Read operations do not block write operations and write operations do not block read operations.
- Sub-millisecond transaction overhead for movement recording.
- Full durability with `synchronous=FULL` protecting against power failure or unexpected host restart.
- Zero external database management.

### Negative
- Single writer concurrency at the SQLite engine level. Because PaxFlux transactions are in-memory SQLite operations taking <1ms, the throughput easily exceeds 1,000 writes/second, far surpassing the required 100 req/s burst limit.
