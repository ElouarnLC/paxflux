import { OutboxActionRecord } from '@paxflux/shared';
import { EventStateRecord, localDb } from './db.js';

/**
 * The two halves of the counter's gauge, read as one database snapshot.
 *
 * The gauge is `authoritative + pending`: one term from `event_state`, one
 * from `outbox_actions`. Reading them as two awaits — even inside a single
 * `liveQuery` querier — leaves a window between them, and an acknowledgment
 * committing in that window produces a pair that was never true at any
 * instant: the outbox already drained while the total that absorbed it has
 * not been read yet. Displayed, that is the count briefly vanishing.
 *
 * The window is narrow but real, and it is widest exactly where it matters.
 * Dexie re-runs an established `liveQuery` when the data it observed
 * changes, so a mid-flight commit is corrected on a settled subscription;
 * the *first* execution has not registered that subscription yet. PaxFlux
 * starts `initOfflineSyncEngine()` before React mounts and a device
 * reopening with a queue can flush it immediately, so the first read of the
 * counter's life is precisely when a concurrent ACK is most likely.
 *
 * A readonly transaction over both tables closes it. IndexedDB serialises
 * transactions whose scopes overlap when either is `readwrite`, so the
 * acknowledgment's own transaction (see `flushOutbox`) either commits
 * wholly before this read begins or waits until it ends. The reader
 * therefore sees old-authoritative + old-pending, or new + new, and never a
 * mixture of the two.
 *
 * Pure read, no side effects, and deliberately not parameterised: it exists
 * so the coherence is a property of one named function that a test can
 * exercise directly rather than a shape a component happens to be written
 * in.
 */
export interface DeviceTruthSnapshot {
  /** Undefined when nothing has been stored for this device yet. */
  snapshot: EventStateRecord | undefined;
  /** Every queued action, oldest first. */
  outboxActions: OutboxActionRecord[];
}

export function readDeviceTruthSnapshot(): Promise<DeviceTruthSnapshot> {
  return localDb.transaction('r', localDb.event_state, localDb.outbox_actions, async () => ({
    snapshot: await localDb.event_state.get('current'),
    outboxActions: await localDb.outbox_actions.orderBy('sequence').toArray(),
  }));
}
