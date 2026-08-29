# ADR-005: Offline-First Client Architecture with IndexedDB Outbox

## Status
Accepted

## Context
Festival and event venues often experience temporary network congestion, Wi-Fi dead zones, or carrier outages. If a counter app fails or freezes when offline, volunteers will lose counts or double-count.
Conversely, if an app claims to be "synced" when offline, supervisors may make dangerous crowd safety decisions based on stale data.

## Decision
PaxFlux implements a robust **offline-first outbox pattern in the client PWA using IndexedDB**:
1. **Local Outbox (`outbox_actions`):** Every tap is immediately written to IndexedDB with a cryptographically unique `client_action_id` (UUID v4) and monotonic `device_sequence` before any network send attempt.
2. **Optimistic Local Projection:** The counter UI updates its local count instantly:
   $$\text{displayedOccupancy} = \text{lastAuthoritativeServerOccupancy} + \sum \text{localPendingDeltas}$$
3. **Explicit Offline Status:** When offline, the UI explicitly displays an offline banner: *"⚠ HORS LIGNE — le comptage continue sur cet appareil; la jauge globale peut être incomplète"*.
4. **Retry & Backoff:** When the network returns (`online` event, window focus, periodic timer), actions are flushed in batches (up to 100 actions) to `/api/v1/device/actions/batch`.
5. **Idempotency & Uncertain-ACK Handling:** Retrying an already applied `client_action_id` returns an idempotent success. If an action's network ACK was lost and the user presses Undo while offline, both the original action and its compensating `reversal` action are preserved in the outbox and submitted in order upon reconnection.
6. **No Correctness Dependency on Background Sync:** IndexedDB and foreground sync workers are the core reliability engine; the Background Sync API is used solely as an optional progressive enhancement.

## Consequences
### Positive
- Zero tap loss during network dropouts.
- Instant tactile and visual feedback for field operators.
- Honest, unambiguous UI regarding synchronization confidence.

### Negative
- Client logic must handle complex outbox transitions, deduplication, and reversal relationships.
