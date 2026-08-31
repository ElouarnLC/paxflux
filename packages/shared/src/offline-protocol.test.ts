import { describe, expect, it } from 'vitest';
import {
  ActionAcknowledgmentSchema,
  BatchSyncResponseSchema,
  CompactEventStateSchema,
} from './offline-protocol.js';

const SPACE_A = '11111111-1111-4111-8111-111111111111';
const SPACE_B = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = '33333333-3333-4333-8333-333333333333';

function validState() {
  return {
    version: 12,
    eventStatus: 'live',
    eventOccupancy: 3,
    eventCapacity: 500,
    spaces: [
      { id: SPACE_A, name: 'Extérieur', kind: 'external', occupancy: 0, capacity: null },
      { id: SPACE_B, name: 'Site', kind: 'leaf', occupancy: 3, capacity: 400 },
    ],
    serverTimeMs: 1_700_000_000_000,
    closingStartedAtMs: null,
  };
}

describe('BatchSyncResponseSchema', () => {
  it('accepts a well-formed response', () => {
    const result = BatchSyncResponseSchema.safeParse({
      acknowledged: [{ clientActionId: ACTION_ID, status: 'applied', movementId: 42 }],
      state: validState(),
    });

    expect(result.success).toBe(true);
  });

  it('rejects the empty-shell response a truncated body produces', () => {
    // `{ acknowledged: [{}], state: {} }` parses as JSON and passes a
    // `typeof`-style shape check, while saying nothing at all. Accepting it
    // would acknowledge nothing, delete nothing, and persist an empty
    // snapshot over a good one.
    const result = BatchSyncResponseSchema.safeParse({ acknowledged: [{}], state: {} });

    expect(result.success).toBe(false);
  });

  it('rejects a response with no state at all', () => {
    expect(BatchSyncResponseSchema.safeParse({ acknowledged: [] }).success).toBe(false);
  });

  it('rejects a response whose acknowledgments are not an array', () => {
    expect(
      BatchSyncResponseSchema.safeParse({ acknowledged: 'applied', state: validState() }).success
    ).toBe(false);
  });

  it('rejects two verdicts for the same action', () => {
    // Two answers for one action is a contradiction, not an answer:
    // whichever the client applied would be arbitrary, and one of them
    // could delete a count the other refused.
    const result = BatchSyncResponseSchema.safeParse({
      acknowledged: [
        { clientActionId: ACTION_ID, status: 'applied', movementId: 4 },
        { clientActionId: ACTION_ID, status: 'rejected', errorCode: 'EVENT_NOT_LIVE' },
      ],
      state: validState(),
    });

    expect(result.success).toBe(false);
  });

  it('accepts distinct acknowledgments in the same response', () => {
    const other = '44444444-4444-4444-8444-444444444444';
    const result = BatchSyncResponseSchema.safeParse({
      acknowledged: [
        { clientActionId: ACTION_ID, status: 'applied', movementId: 4 },
        { clientActionId: other, status: 'duplicate' },
      ],
      state: validState(),
    });

    expect(result.success).toBe(true);
  });
});

describe('ActionAcknowledgmentSchema', () => {
  it('requires a UUID client action id', () => {
    expect(
      ActionAcknowledgmentSchema.safeParse({ clientActionId: 'not-a-uuid', status: 'applied' }).success
    ).toBe(false);
  });

  it('requires a status the client actually knows how to act on', () => {
    expect(
      ActionAcknowledgmentSchema.safeParse({ clientActionId: ACTION_ID, status: 'maybe' }).success
    ).toBe(false);
  });

  it('rejects a movementId that is not a positive integer', () => {
    for (const movementId of [0, -1, 1.5, '42']) {
      expect(
        ActionAcknowledgmentSchema.safeParse({ clientActionId: ACTION_ID, status: 'applied', movementId })
          .success
      ).toBe(false);
    }
  });

  it('accepts a rejection carrying its error code', () => {
    const result = ActionAcknowledgmentSchema.safeParse({
      clientActionId: ACTION_ID,
      status: 'rejected',
      errorCode: 'EVENT_NOT_LIVE',
    });

    expect(result.success).toBe(true);
  });
});

describe('CompactEventStateSchema', () => {
  it('rejects an unknown event status', () => {
    expect(CompactEventStateSchema.safeParse({ ...validState(), eventStatus: 'paused' }).success).toBe(
      false
    );
  });

  it('requires the closing epoch field, so a device can always name it', () => {
    // Absent rather than null would leave a device unable to distinguish
    // "not closing" from "the server did not say", and it must never
    // confirm a drain on a guess.
    const { closingStartedAtMs: _omitted, ...withoutEpoch } = validState();
    expect(CompactEventStateSchema.safeParse(withoutEpoch).success).toBe(false);
    expect(CompactEventStateSchema.safeParse({ ...validState(), closingStartedAtMs: 1_700_000_000_000 }).success).toBe(
      true
    );
  });

  it('rejects a state missing its server timestamp', () => {
    const { serverTimeMs: _omitted, ...withoutTimestamp } = validState();
    expect(CompactEventStateSchema.safeParse(withoutTimestamp).success).toBe(false);
  });

  it('rejects a space with an unknown kind', () => {
    const state = validState();
    state.spaces[1] = { ...state.spaces[1], kind: 'zone' };
    expect(CompactEventStateSchema.safeParse(state).success).toBe(false);
  });

  it('accepts a leaf with no capacity', () => {
    const state = validState();
    state.spaces[1] = { ...state.spaces[1], capacity: null };
    expect(CompactEventStateSchema.safeParse(state).success).toBe(true);
  });
});
