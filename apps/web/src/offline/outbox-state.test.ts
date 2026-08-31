import { describe, expect, it } from 'vitest';
import { OutboxActionOwner, OutboxActionRecord, OutboxSendState } from '@paxflux/shared';
import {
  acknowledgmentTransition,
  describeOutboxError,
  isRetryable,
  isUnresolved,
  manualRetryTransition,
  needsReconciliation,
  networkFailureTransition,
  ownershipTransition,
  recoveryTransition,
  sameOwner,
} from './outbox-state.js';

const OWNER_A: OutboxActionOwner = {
  deviceSessionId: 'session-a',
  eventId: 'event-1',
  checkpointId: 'checkpoint-main',
};

const OWNER_B: OutboxActionOwner = {
  deviceSessionId: 'session-b',
  eventId: 'event-1',
  checkpointId: 'checkpoint-vip',
};

function action(
  overrides: Partial<OutboxActionRecord> & { sendState?: OutboxSendState } = {}
): OutboxActionRecord {
  return {
    clientActionId: 'action-1',
    sequence: 1,
    type: 'count',
    direction: 'a_to_b',
    clientCreatedAtMs: 1_700_000_000_000,
    attempts: 0,
    sendState: 'pending',
    createdAtMs: 1_700_000_000_000,
    owner: OWNER_A,
    ...overrides,
  } as OutboxActionRecord;
}

describe('retryable vs unresolved', () => {
  it('only a pending action may be sent by the engine', () => {
    expect(isRetryable(action({ sendState: 'pending' }))).toBe(true);
    expect(isRetryable(action({ sendState: 'sending' }))).toBe(false);
    expect(isRetryable(action({ sendState: 'rejected' }))).toBe(false);
    expect(isRetryable(action({ sendState: 'quarantined' }))).toBe(false);
  });

  it('every queued action counts as unresolved, including the ones the engine will not send', () => {
    const states: OutboxSendState[] = ['pending', 'sending', 'rejected', 'quarantined'];
    for (const sendState of states) {
      expect(isUnresolved(action({ sendState }))).toBe(true);
    }
  });

  it('flags exactly the states that need a human', () => {
    expect(needsReconciliation(action({ sendState: 'rejected' }))).toBe(true);
    expect(needsReconciliation(action({ sendState: 'quarantined' }))).toBe(true);
    expect(needsReconciliation(action({ sendState: 'pending' }))).toBe(false);
    expect(needsReconciliation(action({ sendState: 'sending' }))).toBe(false);
  });
});

describe('acknowledgmentTransition', () => {
  it('deletes on applied', () => {
    expect(acknowledgmentTransition({ clientActionId: 'a', status: 'applied' })).toEqual({
      kind: 'delete',
      clientActionId: 'a',
      reason: 'applied',
    });
  });

  it('deletes on duplicate — an idempotent success, not a failure', () => {
    expect(acknowledgmentTransition({ clientActionId: 'a', status: 'duplicate' })).toEqual({
      kind: 'delete',
      clientActionId: 'a',
      reason: 'duplicate',
    });
  });

  it('keeps a rejected action, records its code, and takes it out of auto-retry', () => {
    const transition = acknowledgmentTransition({
      clientActionId: 'a',
      status: 'rejected',
      errorCode: 'DIRECTION_NOT_ALLOWED',
    });

    expect(transition.kind).toBe('update');
    expect(transition).toMatchObject({
      changes: { sendState: 'rejected', lastErrorCode: 'DIRECTION_NOT_ALLOWED' },
    });
    if (transition.kind === 'update') {
      expect(isRetryable({ sendState: transition.changes.sendState as OutboxSendState })).toBe(false);
    }
  });

  it('still records a rejection that arrives without a code', () => {
    expect(acknowledgmentTransition({ clientActionId: 'a', status: 'rejected' })).toMatchObject({
      changes: { sendState: 'rejected', lastErrorCode: 'REJECTED' },
    });
  });
});

describe('ownershipTransition', () => {
  it('lets an action through when the paired identity is the one that created it', () => {
    expect(ownershipTransition(action(), OWNER_A)).toBeNull();
  });

  it('quarantines an action created under a different device session', () => {
    expect(ownershipTransition(action(), OWNER_B)).toMatchObject({
      kind: 'update',
      changes: { sendState: 'quarantined', lastErrorCode: 'SESSION_CHANGED' },
    });
  });

  it('quarantines when only the checkpoint differs — a count belongs to its door', () => {
    const otherDoor = { ...OWNER_A, checkpointId: 'checkpoint-other' };
    expect(ownershipTransition(action(), otherDoor)).toMatchObject({
      changes: { sendState: 'quarantined', lastErrorCode: 'SESSION_CHANGED' },
    });
  });

  it('quarantines when only the event differs', () => {
    const otherEvent = { ...OWNER_A, eventId: 'event-2' };
    expect(ownershipTransition(action(), otherEvent)).toMatchObject({
      changes: { sendState: 'quarantined', lastErrorCode: 'SESSION_CHANGED' },
    });
  });

  it('quarantines a legacy action that carries no identity, never adopting it', () => {
    const legacy = action({ owner: undefined });

    const transition = ownershipTransition(legacy, OWNER_A);

    expect(transition).toMatchObject({
      changes: { sendState: 'quarantined', lastErrorCode: 'OWNER_UNKNOWN' },
    });
    // The decision must not carry an owner: guessing one is the failure mode.
    if (transition?.kind === 'update') {
      expect('owner' in transition.changes).toBe(false);
    }
  });

  it('quarantines when nothing is paired at all', () => {
    expect(ownershipTransition(action(), null)).toMatchObject({
      changes: { sendState: 'quarantined', lastErrorCode: 'SESSION_CHANGED' },
    });
  });

  it('compares all three identity components', () => {
    expect(sameOwner(OWNER_A, { ...OWNER_A })).toBe(true);
    expect(sameOwner(OWNER_A, OWNER_B)).toBe(false);
    expect(sameOwner(undefined, OWNER_A)).toBe(false);
    expect(sameOwner(OWNER_A, undefined)).toBe(false);
  });
});

describe('failure and recovery transitions', () => {
  it('returns an in-flight action to pending after a transient failure', () => {
    expect(networkFailureTransition(action({ sendState: 'sending' }), 'HTTP_503')).toMatchObject({
      changes: { sendState: 'pending', lastErrorCode: 'HTTP_503' },
    });
  });

  it('treats a persisted `sending` row as an uncertain ACK and makes it retryable again', () => {
    const transition = recoveryTransition(action({ sendState: 'sending', attempts: 1 }));

    expect(transition).toMatchObject({
      changes: { sendState: 'pending', lastErrorCode: 'UNCERTAIN_ACK' },
    });
  });

  it('leaves rejected and quarantined rows alone during recovery', () => {
    expect(recoveryTransition(action({ sendState: 'rejected' }))).toBeNull();
    expect(recoveryTransition(action({ sendState: 'quarantined' }))).toBeNull();
    expect(recoveryTransition(action({ sendState: 'pending' }))).toBeNull();
  });
});

describe('manualRetryTransition', () => {
  it('puts a rejected action back in the queue and clears its stale code', () => {
    expect(manualRetryTransition(action({ sendState: 'rejected', lastErrorCode: 'EVENT_NOT_LIVE' }))).toEqual({
      kind: 'update',
      clientActionId: 'action-1',
      changes: { sendState: 'pending', lastErrorCode: undefined },
    });
  });

  it('refuses to re-queue a quarantined action, which would send it under the wrong identity', () => {
    expect(manualRetryTransition(action({ sendState: 'quarantined' }))).toBeNull();
  });
});

describe('describeOutboxError', () => {
  it('translates the codes the server actually returns', () => {
    expect(describeOutboxError('DIRECTION_NOT_ALLOWED')).toMatch(/sens de passage/i);
    expect(describeOutboxError('EVENT_NOT_LIVE')).toMatch(/comptage/i);
    expect(describeOutboxError('ORIGINAL_MOVEMENT_NOT_FOUND')).toMatch(/annuler/i);
    expect(describeOutboxError('ALREADY_REVERSED')).toMatch(/déjà été annulé/i);
  });

  it('keeps an unknown code visible instead of hiding it behind a generic message', () => {
    expect(describeOutboxError('SOME_NEW_CODE')).toContain('SOME_NEW_CODE');
  });
});
