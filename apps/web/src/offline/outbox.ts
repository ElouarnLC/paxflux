import { localDb } from './db.js';
import {
  ClientAction,
  OutboxActionRecord,
  Direction,
  BatchSyncResponse,
  CompactEventState,
} from '@paxflux/shared';

let isFlushing = false;

export async function getNextSequence(): Promise<number> {
  return await localDb.transaction('rw', localDb.meta, async () => {
    const record = await localDb.meta.get('next_sequence');
    const current = typeof record?.value === 'number' ? record.value : 0;
    const next = current + 1;
    await localDb.meta.put({ key: 'next_sequence', value: next });
    return next;
  });
}

export async function enqueueCountAction(direction: Direction): Promise<OutboxActionRecord> {
  const clientActionId = crypto.randomUUID();
  const sequence = await getNextSequence();
  const now = Date.now();

  const record: OutboxActionRecord = {
    clientActionId,
    sequence,
    type: 'count',
    direction,
    clientCreatedAtMs: now,
    attempts: 0,
    sendState: 'pending',
    createdAtMs: now,
  };

  await localDb.outbox_actions.add(record);
  // Trigger background flush
  triggerFlush();
  return record;
}

export async function enqueueReversalAction(targetClientActionId: string): Promise<OutboxActionRecord | null> {
  const target = await localDb.outbox_actions.get(targetClientActionId);

  // Case 1: Target was never sent to server (attempts === 0 and pending)
  if (target && target.attempts === 0 && target.sendState === 'pending') {
    await localDb.outbox_actions.delete(targetClientActionId);
    return null;
  }

  // Case 2 & 3: Target was sent or attempted -> Create formal compensating reversal action
  const clientActionId = crypto.randomUUID();
  const sequence = await getNextSequence();
  const now = Date.now();

  const record: OutboxActionRecord = {
    clientActionId,
    sequence,
    type: 'reversal',
    targetClientActionId,
    clientCreatedAtMs: now,
    attempts: 0,
    sendState: 'pending',
    createdAtMs: now,
  };

  await localDb.outbox_actions.add(record);
  triggerFlush();
  return record;
}

export async function getLastCountAction(): Promise<OutboxActionRecord | null> {
  const actions = await localDb.outbox_actions
    .orderBy('createdAtMs')
    .reverse()
    .toArray();

  const counts = actions.filter((a) => a.type === 'count');
  const reversals = new Set(actions.filter((a) => a.type === 'reversal').map((a) => (a as any).targetClientActionId));

  for (const c of counts) {
    if (!reversals.has(c.clientActionId)) {
      return c;
    }
  }
  return null;
}

export async function getPendingActionsCount(): Promise<number> {
  return await localDb.outbox_actions.count();
}

export async function calculatePendingDelta(spaceAId: string, spaceBId: string, isSpaceBLeaf: boolean): Promise<number> {
  const actions = await localDb.outbox_actions.toArray();
  let delta = 0;

  for (const action of actions) {
    if (action.type === 'count') {
      if (action.direction === 'a_to_b') {
        delta += isSpaceBLeaf ? 1 : 0;
      } else {
        delta -= isSpaceBLeaf ? 1 : 0;
      }
    } else if (action.type === 'reversal') {
      // Find target action to invert
      const target = actions.find((a) => a.clientActionId === action.targetClientActionId);
      if (target && target.type === 'count') {
        if (target.direction === 'a_to_b') {
          delta -= isSpaceBLeaf ? 1 : 0;
        } else {
          delta += isSpaceBLeaf ? 1 : 0;
        }
      }
    }
  }

  return delta;
}

export function triggerFlush() {
  if (isFlushing) return;
  flushOutbox().catch((err) => {
    console.debug('Outbox flush error (will retry):', err);
  });
}

export async function flushOutbox(): Promise<BatchSyncResponse | null> {
  if (isFlushing) return null;
  if (!navigator.onLine) return null;

  isFlushing = true;
  try {
    const pendingActions = await localDb.outbox_actions
      .orderBy('sequence')
      .limit(100)
      .toArray();

    if (pendingActions.length === 0) {
      isFlushing = false;
      return null;
    }

    // Mark as sending
    for (const a of pendingActions) {
      await localDb.outbox_actions.update(a.clientActionId, {
        sendState: 'sending',
        attempts: a.attempts + 1,
      });
    }

    const payloadActions: ClientAction[] = pendingActions.map((a) => {
      if (a.type === 'count') {
        return {
          clientActionId: a.clientActionId,
          sequence: a.sequence,
          type: 'count',
          direction: a.direction,
          clientCreatedAtMs: a.clientCreatedAtMs,
        };
      }
      return {
        clientActionId: a.clientActionId,
        sequence: a.sequence,
        type: 'reversal',
        targetClientActionId: a.targetClientActionId,
        clientCreatedAtMs: a.clientCreatedAtMs,
      };
    });

    const pendingTotal = await localDb.outbox_actions.count();

    const response = await fetch('/api/v1/device/actions/batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        actions: payloadActions,
        pendingCount: pendingTotal,
        appVersion: '1.0.0',
      }),
    });

    if (!response.ok) {
      // Non-200 response -> reset sending state
      for (const a of pendingActions) {
        await localDb.outbox_actions.update(a.clientActionId, {
          sendState: 'pending',
          lastErrorCode: `HTTP_${response.status}`,
        });
      }
      isFlushing = false;
      return null;
    }

    const data: BatchSyncResponse = await response.json();

    // Delete acknowledged actions
    const acknowledgedIds = new Set(
      data.acknowledged
        .filter((ack) => ack.status === 'applied' || ack.status === 'duplicate')
        .map((ack) => ack.clientActionId)
    );

    for (const id of acknowledgedIds) {
      await localDb.outbox_actions.delete(id);
    }

    // Update cached compact state
    if (data.state) {
      await localDb.device_cache.put({
        key: 'last_server_state',
        lastState: data.state,
        updatedAtMs: Date.now(),
      });
    }

    isFlushing = false;

    // If there are still pending actions in outbox, trigger next batch flush
    const remainingCount = await localDb.outbox_actions.count();
    if (remainingCount > 0) {
      setTimeout(triggerFlush, 100);
    }

    return data;
  } catch (err: any) {
    isFlushing = false;
    throw err;
  }
}
