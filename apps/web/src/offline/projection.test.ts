import { describe, expect, it } from 'vitest';
import {
  CompactEventState,
  ConfirmedActionRecord,
  OutboxActionRecord,
  OutboxActionOwner,
} from '@paxflux/shared';
import { projectPendingActions, projectedSpaceOccupancy } from './projection.js';

const EXTERNAL = 'space-exterieur';
const SITE = 'space-site';
const VIP = 'space-vip';
const TOTAL = 'space-total-aggregate';

const OWNER: OutboxActionOwner = {
  deviceSessionId: 'device-1',
  eventId: 'event-1',
  checkpointId: 'checkpoint-1',
};

function stateWith(occupancies: Partial<Record<string, number>> = {}): CompactEventState {
  const site = occupancies[SITE] ?? 0;
  const vip = occupancies[VIP] ?? 0;
  return {
    version: 12,
    eventStatus: 'live',
    eventOccupancy: site + vip,
    eventCapacity: 500,
    spaces: [
      { id: EXTERNAL, name: 'Extérieur', kind: 'external', occupancy: 0, capacity: null },
      { id: SITE, name: 'Site', kind: 'leaf', occupancy: site, capacity: 400 },
      { id: VIP, name: 'VIP', kind: 'leaf', occupancy: vip, capacity: 50 },
      { id: TOTAL, name: 'Total', kind: 'aggregate', occupancy: site + vip, capacity: null },
    ],
    serverTimeMs: 1_700_000_000_000,
  };
}

let nextSequence = 1;

function count(direction: 'a_to_b' | 'b_to_a', id = `count-${nextSequence}`): OutboxActionRecord {
  const sequence = nextSequence++;
  return {
    clientActionId: id,
    sequence,
    type: 'count',
    direction,
    clientCreatedAtMs: 1_700_000_000_000 + sequence,
    attempts: 0,
    sendState: 'pending',
    createdAtMs: 1_700_000_000_000 + sequence,
    owner: OWNER,
  };
}

function reversalOf(target: OutboxActionRecord): OutboxActionRecord {
  const sequence = nextSequence++;
  return {
    clientActionId: `reversal-${sequence}`,
    sequence,
    type: 'reversal',
    targetClientActionId: target.clientActionId,
    clientCreatedAtMs: 1_700_000_000_000 + sequence,
    attempts: 0,
    sendState: 'pending',
    createdAtMs: 1_700_000_000_000 + sequence,
    owner: OWNER,
  };
}

/** Extérieur ⇄ Site: A is external, B is a leaf. */
const BOUNDARY = { spaceAId: EXTERNAL, spaceBId: SITE };
/** Site ⇄ VIP: both endpoints are leaves. */
const INTERNAL = { spaceAId: SITE, spaceBId: VIP };

describe('projectPendingActions — the four directions', () => {
  it('external → leaf raises the global gauge and the leaf by one', () => {
    const result = projectPendingActions(stateWith(), BOUNDARY, [count('a_to_b')]);

    expect(result.globalDelta).toBe(1);
    expect(result.spaceDeltas.get(SITE)).toBe(1);
    // An external space holds no occupancy, so it must not appear at all.
    expect(result.spaceDeltas.has(EXTERNAL)).toBe(false);
  });

  it('leaf → external lowers the global gauge and the leaf by one', () => {
    const result = projectPendingActions(stateWith({ [SITE]: 10 }), BOUNDARY, [count('b_to_a')]);

    expect(result.globalDelta).toBe(-1);
    expect(result.spaceDeltas.get(SITE)).toBe(-1);
    expect(result.projectedEventOccupancy).toBe(9);
  });

  it('leaf A → leaf B leaves the global gauge untouched and moves −1/+1', () => {
    const result = projectPendingActions(stateWith({ [SITE]: 10 }), INTERNAL, [count('a_to_b')]);

    expect(result.globalDelta).toBe(0);
    expect(result.spaceDeltas.get(SITE)).toBe(-1);
    expect(result.spaceDeltas.get(VIP)).toBe(1);
  });

  it('leaf B → leaf A leaves the global gauge untouched and moves −1/+1 the other way', () => {
    const result = projectPendingActions(stateWith({ [SITE]: 10, [VIP]: 4 }), INTERNAL, [count('b_to_a')]);

    expect(result.globalDelta).toBe(0);
    expect(result.spaceDeltas.get(VIP)).toBe(-1);
    expect(result.spaceDeltas.get(SITE)).toBe(1);
  });
});

describe('projectPendingActions — reversals', () => {
  it('reverses a boundary entry exactly', () => {
    const entry = count('a_to_b');
    const result = projectPendingActions(stateWith(), BOUNDARY, [entry, reversalOf(entry)]);

    expect(result.globalDelta).toBe(0);
    expect(result.spaceDeltas.get(SITE)).toBe(0);
  });

  it('reverses a boundary exit exactly', () => {
    const exit = count('b_to_a');
    const result = projectPendingActions(stateWith({ [SITE]: 3 }), BOUNDARY, [exit, reversalOf(exit)]);

    expect(result.globalDelta).toBe(0);
    expect(result.projectedEventOccupancy).toBe(3);
  });

  it('reverses an internal transfer exactly, on both leaves', () => {
    const transfer = count('a_to_b');
    const result = projectPendingActions(stateWith({ [SITE]: 8 }), INTERNAL, [transfer, reversalOf(transfer)]);

    expect(result.globalDelta).toBe(0);
    expect(result.spaceDeltas.get(SITE)).toBe(0);
    expect(result.spaceDeltas.get(VIP)).toBe(0);
  });

  it('reports a reversal whose target is no longer local instead of guessing', () => {
    const alreadyAcknowledged = count('a_to_b', 'gone-from-outbox');
    const orphanReversal = reversalOf(alreadyAcknowledged);

    const result = projectPendingActions(stateWith({ [SITE]: 1 }), BOUNDARY, [orphanReversal]);

    // The original's effect is already inside the authoritative state; the
    // reversal's own effect only lands when the server applies it.
    expect(result.globalDelta).toBe(0);
    expect(result.unprojectableActionIds).toEqual([orphanReversal.clientActionId]);
  });
});

describe('projectPendingActions — sequences', () => {
  it('keeps the global gauge exact across extérieur → site → VIP → site → extérieur', () => {
    const state = stateWith();

    const enter = count('a_to_b');
    const afterEnter = projectPendingActions(state, BOUNDARY, [enter]);
    expect(afterEnter.projectedEventOccupancy).toBe(1);

    // Two internal legs at the VIP checkpoint: neither may move the global.
    const toVip = count('a_to_b');
    const backToSite = count('b_to_a');
    const internal = projectPendingActions(state, INTERNAL, [toVip, backToSite]);
    expect(internal.globalDelta).toBe(0);
    expect(internal.spaceDeltas.get(SITE)).toBe(0);
    expect(internal.spaceDeltas.get(VIP)).toBe(0);

    // Leaving through the boundary brings the projection back to where it
    // started: one entry and one exit, whatever happened in between.
    const leave = count('b_to_a');
    const afterLeave = projectPendingActions(state, BOUNDARY, [enter, leave]);
    expect(afterLeave.projectedEventOccupancy).toBe(0);
  });

  it('accumulates three entries and one undo to +2', () => {
    const state = stateWith();
    const first = count('a_to_b');
    const second = count('a_to_b');
    const third = count('a_to_b');

    const result = projectPendingActions(state, BOUNDARY, [first, second, third, reversalOf(third)]);

    expect(result.globalDelta).toBe(2);
    expect(result.projectedEventOccupancy).toBe(2);
  });
});

describe('projectedSpaceOccupancy', () => {
  it('adds the local delta to the authoritative occupancy of a leaf', () => {
    const state = stateWith({ [SITE]: 10, [VIP]: 2 });
    const projection = projectPendingActions(state, INTERNAL, [count('a_to_b')]);

    expect(projectedSpaceOccupancy(state, SITE, projection)).toBe(9);
    expect(projectedSpaceOccupancy(state, VIP, projection)).toBe(3);
  });

  it('leaves an aggregate at its authoritative value rather than deriving one locally', () => {
    const state = stateWith({ [SITE]: 10, [VIP]: 2 });
    const projection = projectPendingActions(state, INTERNAL, [count('a_to_b')]);

    expect(projectedSpaceOccupancy(state, TOTAL, projection)).toBe(12);
  });

  it('returns null for a space the authoritative state does not know', () => {
    const state = stateWith();
    const projection = projectPendingActions(state, BOUNDARY, []);

    expect(projectedSpaceOccupancy(state, 'space-unknown', projection)).toBeNull();
  });
});

describe('projectPendingActions — reversals of confirmed counts', () => {
  function confirmedCount(
    id: string,
    direction: 'a_to_b' | 'b_to_a',
    endpoints: { spaceAId: string; spaceBId: string }
  ): ConfirmedActionRecord {
    return {
      clientActionId: id,
      type: 'count',
      direction,
      owner: OWNER,
      spaceAId: endpoints.spaceAId,
      spaceBId: endpoints.spaceBId,
      clientCreatedAtMs: 1_700_000_000_000,
      confirmedAtMs: 1_700_000_000_500,
    };
  }

  function reversalTargeting(targetId: string): OutboxActionRecord {
    const sequence = nextSequence++;
    return {
      clientActionId: `reversal-of-${targetId}`,
      sequence,
      type: 'reversal',
      targetClientActionId: targetId,
      clientCreatedAtMs: 1_700_000_000_000 + sequence,
      attempts: 0,
      sendState: 'pending',
      createdAtMs: 1_700_000_000_000 + sequence,
      owner: OWNER,
    };
  }

  it('projects the undo of a count the server already confirmed', () => {
    // The entry is inside the authoritative occupancy already, so the
    // reversal's own −1 is a real delta on top of it, not a double count.
    const state = stateWith({ [SITE]: 1 });
    const confirmed = [confirmedCount('confirmed-entry', 'a_to_b', BOUNDARY)];

    const result = projectPendingActions(state, BOUNDARY, [reversalTargeting('confirmed-entry')], confirmed);

    expect(result.globalDelta).toBe(-1);
    expect(result.projectedEventOccupancy).toBe(0);
    expect(result.unprojectableActionIds).toEqual([]);
  });

  it('projects the undo of a confirmed internal transfer on both leaves', () => {
    const state = stateWith({ [SITE]: 7, [VIP]: 1 });
    const confirmed = [confirmedCount('confirmed-transfer', 'a_to_b', INTERNAL)];

    const result = projectPendingActions(state, INTERNAL, [reversalTargeting('confirmed-transfer')], confirmed);

    expect(result.globalDelta).toBe(0);
    expect(result.spaceDeltas.get(VIP)).toBe(-1);
    expect(result.spaceDeltas.get(SITE)).toBe(1);
  });

  it('uses the endpoints the confirmed count was made across, not the current ones', () => {
    // The device has since been re-paired onto the internal checkpoint, but
    // the count it is undoing was made at the boundary. Projecting it with
    // today's endpoints would move the wrong leaf.
    const state = stateWith({ [SITE]: 1 });
    const confirmed = [confirmedCount('confirmed-entry', 'a_to_b', BOUNDARY)];

    const result = projectPendingActions(state, INTERNAL, [reversalTargeting('confirmed-entry')], confirmed);

    expect(result.spaceDeltas.get(SITE)).toBe(-1);
    expect(result.spaceDeltas.has(VIP)).toBe(false);
    expect(result.globalDelta).toBe(-1);
  });

  it('still reports a reversal whose target is neither queued nor confirmed', () => {
    const orphan = reversalTargeting('never-heard-of-it');

    const result = projectPendingActions(stateWith({ [SITE]: 1 }), BOUNDARY, [orphan], []);

    expect(result.globalDelta).toBe(0);
    expect(result.unprojectableActionIds).toEqual([orphan.clientActionId]);
  });
});
