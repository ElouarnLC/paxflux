# ADR-004: Append-Only Movement Ledger and Materialized State

## Status
Accepted

## Context
A simplistic counter system might update a mutable `current_occupancy` integer in place. However, in an event setting:
- Adjustments and mistakes happen and must be auditable.
- Post-event reporting requires reconstructing attendance curves over time and entrance throughput rates.
- Concurrency and offline reconciliation require mathematical idempotency and invariant verification.
- Erroneous updates must be compensated, never destructively erased.

## Decision
PaxFlux establishes the **append-only `movements` table as the sole source of truth**:
1. **Immutable Ledger:** Every count tap, counter reversal (Undo), and supervisor adjustment appends a new immutable row in `movements`.
2. **Materialized Projection:** Current space occupancy is stored in `space_state` as a materialized view updated within the exact same database transaction as the ledger insert.
3. **Reconstructability:** `space_state` can be rebuilt from scratch at any time by summing all movements from the beginning of the event.
4. **Conservation Invariants:**
   - Movement from `external` space to an internal `leaf` space increments the leaf space and the global event total.
   - Movement between two internal `leaf` spaces decrements the source leaf and increments the destination leaf, preserving the global event total.
   - `aggregate` spaces cannot be movement endpoints; their occupancy is always the derived sum of their active leaf children.
5. **No Clamping / Discarding:** Capacity overflow and negative counts are recorded faithfully and surfaced as anomalies; movements are never rejected due to capacity limits.

## Consequences
### Positive
- Complete mathematical auditability and temporal replay.
- Exact traceability of who recorded what, when, and from which device/checkpoint.
- Robust recovery from any potential state drift via state rebuild functions.

### Negative
- Ledger table grows with every tap (1 million taps requires ~100MB of SQLite storage, well within hardware capabilities for any multi-day event).
