import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OutboxActionOwner } from '@paxflux/shared';
import { localDb } from './db.js';
import { enqueueCountAction, enqueueReversalAction, getLastCountAction } from './outbox.js';
import { recordConfirmedAction } from './confirmed-actions.js';

/**
 * The Dexie layer under a real (in-memory) IndexedDB.
 *
 * The atomicity these tests are about cannot be observed from a pure
 * function: what matters is precisely which writes commit together. Running
 * against a genuine IndexedDB implementation is the only way to see a
 * transaction abort and check what it left behind.
 */

const OWNER: OutboxActionOwner = {
  deviceSessionId: '11111111-1111-4111-8111-111111111111',
  eventId: '22222222-2222-4222-8222-222222222222',
  checkpointId: '33333333-3333-4333-8333-333333333333',
};

const ENDPOINTS = {
  spaceAId: '44444444-4444-4444-8444-444444444444',
  spaceBId: '55555555-5555-4555-8555-555555555555',
};

beforeEach(async () => {
  await localDb.open();
  await localDb.outbox_actions.clear();
  await localDb.confirmed_actions.clear();
  await localDb.meta.clear();
});

afterEach(async () => {
  await localDb.outbox_actions.clear();
  await localDb.confirmed_actions.clear();
  await localDb.meta.clear();
});

describe('enqueueCountAction', () => {
  it('commits the sequence allocation and the insert together', async () => {
    const first = await enqueueCountAction('a_to_b', OWNER);
    const second = await enqueueCountAction('b_to_a', OWNER);

    expect(second.sequence).toBe(first.sequence + 1);
    const rows = await localDb.outbox_actions.toArray();
    expect(rows).toHaveLength(2);

    // No gap: every allocated sequence belongs to a row that exists.
    const nextSequence = (await localDb.meta.get('next_sequence'))?.value;
    expect(nextSequence).toBe(second.sequence);
  });

  it('allocates distinct sequences under concurrent taps', async () => {
    const created = await Promise.all([
      enqueueCountAction('a_to_b', OWNER),
      enqueueCountAction('a_to_b', OWNER),
      enqueueCountAction('a_to_b', OWNER),
    ]);

    const sequences = created.map((r) => r.sequence).sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(3);
    expect(await localDb.outbox_actions.count()).toBe(3);
  });
});

describe('enqueueReversalAction — confirmed target', () => {
  async function seedConfirmedCount(clientActionId: string) {
    await recordConfirmedAction(
      {
        clientActionId,
        sequence: 1,
        type: 'count',
        direction: 'a_to_b',
        clientCreatedAtMs: Date.now(),
        attempts: 1,
        sendState: 'pending',
        createdAtMs: Date.now(),
        owner: OWNER,
      },
      ENDPOINTS
    );
  }

  it('queues the reversal and marks the confirmed count in one commit', async () => {
    const targetId = '66666666-6666-4666-8666-666666666666';
    await seedConfirmedCount(targetId);

    const outcome = await enqueueReversalAction(targetId, OWNER);

    expect(outcome.kind).toBe('queued');
    const reversal = (await localDb.outbox_actions.toArray())[0];
    expect(reversal.type).toBe('reversal');
    expect((await localDb.confirmed_actions.get(targetId))?.reversedAtMs).toBeDefined();
  });

  it('refuses a second undo of the same confirmed count', async () => {
    const targetId = '77777777-7777-4777-8777-777777777777';
    await seedConfirmedCount(targetId);

    await enqueueReversalAction(targetId, OWNER);
    const second = await enqueueReversalAction(targetId, OWNER);

    expect(second).toEqual({ kind: 'refused', reason: 'target_not_reconcilable' });
    // Exactly one compensating movement, never two.
    expect(await localDb.outbox_actions.count()).toBe(1);
  });

  it('queues exactly one reversal when two undos race for the same target', async () => {
    const targetId = '88888888-8888-4888-8888-888888888888';
    await seedConfirmedCount(targetId);

    const [a, b] = await Promise.all([
      enqueueReversalAction(targetId, OWNER),
      enqueueReversalAction(targetId, OWNER),
    ]);

    // Check-then-act outside a transaction would let both pass the
    // `reversedAtMs` check and queue two compensating movements.
    const queued = [a, b].filter((outcome) => outcome.kind === 'queued');
    expect(queued).toHaveLength(1);
    expect(await localDb.outbox_actions.count()).toBe(1);
  });

  it('never stamps the confirmed count when the reversal insert itself fails', async () => {
    const targetId = '99999999-9999-4999-8999-999999999999';
    await seedConfirmedCount(targetId);

    // Fails at the insert. This is the ordering guarantee: the
    // `reversedAtMs` stamp comes after, never before, so a count is never
    // left neither undone nor undoable.
    const realAdd = localDb.outbox_actions.add.bind(localDb.outbox_actions);
    // Rejecting with Dexie's own promise flavour so the failure propagates
    // through the transaction exactly as a real write error would.
    localDb.outbox_actions.add = () => Dexie.Promise.reject(new Error('simulated write failure'));

    await expect(enqueueReversalAction(targetId, OWNER)).rejects.toThrow('simulated write failure');

    localDb.outbox_actions.add = realAdd;

    expect(await localDb.outbox_actions.count()).toBe(0);
    expect((await localDb.confirmed_actions.get(targetId))?.reversedAtMs).toBeUndefined();

    // And the operator can still undo it once the failure passes.
    const retry = await enqueueReversalAction(targetId, OWNER);
    expect(retry.kind).toBe('queued');
    expect((await localDb.confirmed_actions.get(targetId))?.reversedAtMs).toBeDefined();
  });

  it('rolls the queued reversal back when a later write in the same commit fails', async () => {
    const targetId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await seedConfirmedCount(targetId);

    // Fails *after* the reversal has been inserted. Only a real transaction
    // undoes that insert; sequential writes would leave a compensating
    // movement queued while the confirmed count still looks undoable — so
    // the next undo would queue a second one for the same original.
    const realPut = localDb.confirmed_actions.put.bind(localDb.confirmed_actions);
    localDb.confirmed_actions.put = () => Dexie.Promise.reject(new Error('simulated stamp failure'));

    await expect(enqueueReversalAction(targetId, OWNER)).rejects.toThrow('simulated stamp failure');

    localDb.confirmed_actions.put = realPut;

    expect(await localDb.outbox_actions.count()).toBe(0);
    expect((await localDb.confirmed_actions.get(targetId))?.reversedAtMs).toBeUndefined();

    // Exactly one reversal once the failure passes, never two.
    expect((await enqueueReversalAction(targetId, OWNER)).kind).toBe('queued');
    expect(await localDb.outbox_actions.count()).toBe(1);
  });

  it('refuses to undo a confirmed count made under another identity', async () => {
    const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await recordConfirmedAction(
      {
        clientActionId: targetId,
        sequence: 1,
        type: 'count',
        direction: 'a_to_b',
        clientCreatedAtMs: Date.now(),
        attempts: 1,
        sendState: 'pending',
        createdAtMs: Date.now(),
        owner: { ...OWNER, deviceSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      },
      ENDPOINTS
    );

    expect(await enqueueReversalAction(targetId, OWNER)).toEqual({
      kind: 'refused',
      reason: 'target_not_reconcilable',
    });
    expect(await localDb.outbox_actions.count()).toBe(0);
  });
});

describe('getLastCountAction', () => {
  it('offers a queued tap, then stops offering it once undone', async () => {
    const tap = await enqueueCountAction('a_to_b', OWNER);

    expect(await getLastCountAction(OWNER)).toMatchObject({
      source: 'outbox',
      clientActionId: tap.clientActionId,
    });

    // Never sent, so undo simply removes it — no compensating movement.
    expect(await enqueueReversalAction(tap.clientActionId, OWNER)).toEqual({ kind: 'deleted_locally' });
    expect(await getLastCountAction(OWNER)).toBeNull();
  });

  it('offers a confirmed count the outbox no longer holds', async () => {
    const targetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await recordConfirmedAction(
      {
        clientActionId: targetId,
        sequence: 1,
        type: 'count',
        direction: 'b_to_a',
        clientCreatedAtMs: Date.now(),
        attempts: 1,
        sendState: 'pending',
        createdAtMs: Date.now(),
        owner: OWNER,
      },
      ENDPOINTS
    );

    expect(await getLastCountAction(OWNER)).toMatchObject({
      source: 'confirmed',
      clientActionId: targetId,
      direction: 'b_to_a',
    });
  });

  it('offers nothing to an identity that made none of it', async () => {
    await enqueueCountAction('a_to_b', OWNER);

    expect(await getLastCountAction({ ...OWNER, deviceSessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }))
      .toBeNull();
  });
});
