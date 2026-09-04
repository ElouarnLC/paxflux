import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactEventState, OutboxActionOwner, OutboxActionRecord } from '@paxflux/shared';
import { localDb } from './db.js';
import { readDeviceTruthSnapshot } from './truth-snapshot.js';

/**
 * The read side of the acknowledgment, under a forced interleaving.
 *
 * `flushOutbox` already commits the outbox deletion and the new
 * authoritative state together, so the *database* never rests in a mixed
 * state. What these tests are about is the reader: the counter's gauge is
 * `authoritative + pending`, one term from each table, and a reader that
 * takes them as two separate reads can still catch the commit between them
 * — seeing the outbox already drained against a total that has not yet
 * absorbed it. Displayed, that is the operator's count vanishing.
 *
 * Dexie re-runs an established `liveQuery` when observed data changes, so a
 * settled subscription self-corrects. The first execution has not
 * established that subscription yet, and PaxFlux starts its sync engine
 * before React mounts — a handset reopening with a queue flushes it
 * immediately. The first read of the counter's life is exactly when this
 * race is most likely, which is why it is worth closing rather than
 * arguing about.
 *
 * The interleaving here is forced, not raced: the writer is issued from
 * inside the reader, strictly between its two logical reads, so there is
 * nothing timing-dependent to be flaky about.
 */

const OWNER: OutboxActionOwner = {
  deviceSessionId: '11111111-1111-4111-8111-111111111111',
  eventId: '22222222-2222-4222-8222-222222222222',
  checkpointId: '33333333-3333-4333-8333-333333333333',
};

const PENDING_ACTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function stateAt(version: number, occupancy: number): CompactEventState {
  return {
    version,
    eventStatus: 'live',
    eventOccupancy: occupancy,
    eventCapacity: 500,
    spaces: [],
    serverTimeMs: 1_700_000_000_000 + version,
    closingStartedAtMs: null,
  };
}

const queuedEntry: OutboxActionRecord = {
  clientActionId: PENDING_ACTION_ID,
  sequence: 1,
  type: 'count',
  direction: 'a_to_b',
  clientCreatedAtMs: 1_700_000_000_000,
  attempts: 0,
  sendState: 'pending',
  createdAtMs: 1_700_000_000_000,
  owner: OWNER,
};

/** The state before the acknowledgment: server at 0, one entry queued. */
async function seedPreAcknowledgment(): Promise<void> {
  await localDb.event_state.put({
    key: 'current',
    eventId: OWNER.eventId,
    state: stateAt(1, 0),
    updatedAtMs: 1_700_000_000_000,
  });
  await localDb.outbox_actions.put(queuedEntry);
}

/**
 * The acknowledgment, issued straight against IndexedDB.
 *
 * Deliberately not through Dexie: this has to behave like a writer that
 * knows nothing about the reader, and calling `localDb.transaction` from
 * inside the reader's own transaction zone would nest rather than compete.
 * Raw IDB shares the same connection and therefore the same transaction
 * scheduler, which is the thing under test.
 *
 * Returns as soon as the transaction is *created* — that is the attempt.
 * `committed` tells the caller whether it has since been allowed to land.
 */
function issueAcknowledgment(): { committed: () => boolean; done: Promise<void> } {
  const raw = localDb.backendDB();
  const tx = raw.transaction(['event_state', 'outbox_actions'], 'readwrite');

  let committed = false;
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      committed = true;
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('acknowledgment aborted'));
  });

  // Exactly what `flushOutbox` commits together: the acknowledged row leaves
  // the outbox, and the state that absorbed it replaces the old one.
  tx.objectStore('outbox_actions').delete(PENDING_ACTION_ID);
  tx.objectStore('event_state').put({
    key: 'current',
    eventId: OWNER.eventId,
    state: stateAt(2, 1),
    updatedAtMs: 1_700_000_000_001,
  });

  return { committed: () => committed, done };
}

/** What the counter would compute from a pair of reads. */
const gaugeOf = (pair: { snapshot?: { state: CompactEventState } | undefined; outboxActions: unknown[] }) =>
  (pair.snapshot?.state.eventOccupancy ?? 0) + pair.outboxActions.length;

beforeEach(async () => {
  await localDb.open();
  await localDb.event_state.clear();
  await localDb.outbox_actions.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await localDb.event_state.clear();
  await localDb.outbox_actions.clear();
});

describe('the two halves of the gauge are read as one snapshot', () => {
  it('two separate reads can observe a pair that was never true', async () => {
    // The discriminating case, written out rather than described: this is
    // the shape `CounterView` had before `readDeviceTruthSnapshot`, and it
    // is here to prove the transaction is doing something.
    await seedPreAcknowledgment();

    let ack: ReturnType<typeof issueAcknowledgment> | null = null;
    const readWithoutTransaction = async () => {
      const snapshot = await localDb.event_state.get('current');
      // The acknowledgment commits in the gap between the two reads.
      ack = issueAcknowledgment();
      await ack.done;
      const outboxActions = await localDb.outbox_actions.orderBy('sequence').toArray();
      return { snapshot, outboxActions };
    };

    const pair = await readWithoutTransaction();

    expect(ack!.committed(), 'the acknowledgment landed inside the window').toBe(true);
    expect(pair.snapshot?.state.eventOccupancy, 'the old authoritative total').toBe(0);
    expect(pair.outboxActions, 'the new, drained outbox').toHaveLength(0);
    // 0 + 0. The server holds 1 and this device holds nothing: the count the
    // operator made is on neither side of the sum.
    expect(gaugeOf(pair), 'a gauge that was never true at any instant').toBe(0);
  });

  it('one readonly transaction never observes the mixture', async () => {
    await seedPreAcknowledgment();

    // The acknowledgment is issued from inside the reader, after the first
    // logical read has resolved and before the second is asked for — the
    // same window the test above walks through. Not awaited: awaiting a
    // foreign promise inside a Dexie transaction would end it, and the
    // point is that the writer competes rather than takes turns.
    let ack: ReturnType<typeof issueAcknowledgment> | null = null;
    const stateTable = localDb.event_state;
    const realGet = stateTable.get.bind(stateTable);
    vi.spyOn(stateTable, 'get').mockImplementation((async (key: string) => {
      const record = await realGet(key);
      ack ??= issueAcknowledgment();
      return record;
    }) as typeof stateTable.get);

    const pair = await readDeviceTruthSnapshot();

    expect(ack, 'the acknowledgment really was attempted inside the window').not.toBeNull();
    // IndexedDB serialises a readwrite transaction against an open readonly
    // one over the same stores, so the attempt waits rather than landing
    // half-way through the read.
    expect(ack!.committed(), 'it could not commit while the snapshot was open').toBe(false);

    const gauge = gaugeOf(pair);
    const before = pair.snapshot?.state.eventOccupancy === 0 && pair.outboxActions.length === 1;
    const after = pair.snapshot?.state.eventOccupancy === 1 && pair.outboxActions.length === 0;
    expect(
      before || after,
      `expected old+old or new+new, got occupancy ${pair.snapshot?.state.eventOccupancy} with ${pair.outboxActions.length} queued`
    ).toBe(true);
    // Either way the operator's count is on exactly one side of the sum.
    expect(gauge, 'the gauge holds still across the acknowledgment').toBe(1);

    // And the writer is not starved: it lands as soon as the read is done.
    await ack!.done;
    expect((await localDb.event_state.get('current'))?.state.eventOccupancy).toBe(1);
    expect(await localDb.outbox_actions.count()).toBe(0);
  });

  it('reads the same pair the counter derives its gauge from', async () => {
    // Guards the helper's contract rather than the race: the component
    // reads `snapshot` and `outboxActions` off this shape.
    await seedPreAcknowledgment();

    const pair = await readDeviceTruthSnapshot();
    expect(pair.snapshot?.eventId).toBe(OWNER.eventId);
    expect(pair.outboxActions.map((a) => a.clientActionId)).toEqual([PENDING_ACTION_ID]);
  });

  it('returns an undefined snapshot rather than throwing on a fresh device', async () => {
    const pair = await readDeviceTruthSnapshot();
    expect(pair.snapshot).toBeUndefined();
    expect(pair.outboxActions).toEqual([]);
  });
});
