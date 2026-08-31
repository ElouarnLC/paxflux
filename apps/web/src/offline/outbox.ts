import { localDb } from './db.js';
import {
  ClientAction,
  OutboxActionRecord,
  OutboxActionOwner,
  Direction,
  BatchSyncResponse,
  ActionAcknowledgment,
} from '@paxflux/shared';
import { CLIENT_APP_VERSION } from '../version.js';
import { currentOwner, persistAuthoritativeState } from './snapshot.js';
import {
  OutboxTransition,
  acknowledgmentTransition,
  isRetryable,
  manualRetryTransition,
  networkFailureTransition,
  ownershipTransition,
  recoveryTransition,
} from './outbox-state.js';

/** Outcome of one flush attempt, so the retry engine can pace itself. */
export type FlushOutcome =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'sent'; applied: number; rejected: number }
  | { kind: 'failed'; errorCode: string };

let isFlushing = false;

type OutboxListener = () => void;
const outboxListeners = new Set<OutboxListener>();

/**
 * Lets the retry engine know the outbox gained something it may send.
 *
 * Enqueueing cannot simply fire a flush of its own: the engine paces itself
 * from the end of each tick, so an out-of-band attempt would leave the timer
 * still armed for whatever delay it chose when the outbox was empty — up to
 * the idle interval. The engine owns pacing; this only tells it to re-decide.
 */
export function onOutboxChanged(listener: OutboxListener): () => void {
  outboxListeners.add(listener);
  return () => outboxListeners.delete(listener);
}

function notifyOutboxChanged() {
  for (const listener of outboxListeners) {
    try {
      listener();
    } catch (err) {
      console.debug('An outbox listener threw; the others still run:', err);
    }
  }
}

export async function getNextSequence(): Promise<number> {
  return await localDb.transaction('rw', localDb.meta, async () => {
    const record = await localDb.meta.get('next_sequence');
    const current = typeof record?.value === 'number' ? record.value : 0;
    const next = current + 1;
    await localDb.meta.put({ key: 'next_sequence', value: next });
    return next;
  });
}

function generateActionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (HTTP over LAN IP)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function applyTransitions(transitions: OutboxTransition[]): Promise<void> {
  for (const transition of transitions) {
    if (transition.kind === 'delete') {
      await localDb.outbox_actions.delete(transition.clientActionId);
    } else {
      await localDb.outbox_actions.update(transition.clientActionId, transition.changes);
    }
  }
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Records a tap. The owner is stamped in at creation: the batch endpoint
 * derives event, checkpoint and session from the *current* cookie, so an
 * untagged action would be silently applied under whatever pairing happens
 * to be active when it finally leaves.
 */
export async function enqueueCountAction(
  direction: Direction,
  owner: OutboxActionOwner
): Promise<OutboxActionRecord> {
  const clientActionId = generateActionId();
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
    owner,
  };

  await localDb.outbox_actions.add(record);
  notifyOutboxChanged();
  return record;
}

export type ReversalOutcome =
  | { kind: 'deleted_locally' }
  | { kind: 'queued'; record: OutboxActionRecord }
  | { kind: 'refused'; reason: 'target_not_reconcilable' };

/**
 * Undo, per ADR-005.
 *
 *  - a tap that never left the device is simply removed: there is nothing on
 *    the server to compensate for;
 *  - a tap that was attempted — even once, even without an answer — leaves
 *    both the original and a compensating reversal in the queue, in order.
 *    The server may already hold the original; if it does not, the reversal
 *    is refused with `ORIGINAL_MOVEMENT_NOT_FOUND` and surfaces for
 *    reconciliation rather than silently deleting a real count;
 *  - a tap that is quarantined or already rejected cannot be reversed here.
 *    Its original will not be sent under this identity, so a reversal would
 *    either target a movement that does not exist or, worse, one made at a
 *    different door.
 */
export async function enqueueReversalAction(
  targetClientActionId: string,
  owner: OutboxActionOwner
): Promise<ReversalOutcome> {
  const target = await localDb.outbox_actions.get(targetClientActionId);

  if (target && (target.sendState === 'quarantined' || target.sendState === 'rejected')) {
    return { kind: 'refused', reason: 'target_not_reconcilable' };
  }

  if (target && target.attempts === 0 && target.sendState === 'pending') {
    await localDb.outbox_actions.delete(targetClientActionId);
    notifyOutboxChanged();
    return { kind: 'deleted_locally' };
  }

  const clientActionId = generateActionId();
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
    owner,
  };

  await localDb.outbox_actions.add(record);
  notifyOutboxChanged();
  return { kind: 'queued', record };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The most recent count this pairing made that has not been undone and is
 * still actionable.
 *
 * Quarantined and rejected actions are excluded: offering "annuler" on a
 * count that belongs to a previous pairing, or that the server already
 * refused, would produce a reversal nobody can apply.
 */
export async function getLastCountAction(owner: OutboxActionOwner | null): Promise<OutboxActionRecord | null> {
  if (!owner) return null;

  const actions = await localDb.outbox_actions.orderBy('createdAtMs').reverse().toArray();

  const reversedTargets = new Set(
    actions
      .filter((a): a is OutboxActionRecord & { type: 'reversal' } => a.type === 'reversal')
      .map((a) => a.targetClientActionId)
  );

  for (const action of actions) {
    if (action.type !== 'count') continue;
    if (action.sendState === 'quarantined' || action.sendState === 'rejected') continue;
    if (action.owner?.deviceSessionId !== owner.deviceSessionId) continue;
    if (reversedTargets.has(action.clientActionId)) continue;
    return action;
  }
  return null;
}

/**
 * Everything still standing between this device and "fully synced",
 * including actions the engine will never send on its own.
 *
 * This is the number the heartbeat and the batch report, because it is the
 * one that must gate a normal `/close`: a device holding a rejected count is
 * not drained.
 */
export async function getUnresolvedActionsCount(): Promise<number> {
  return localDb.outbox_actions.count();
}

/** Actions the engine may still send by itself. */
export async function getRetryableActionsCount(): Promise<number> {
  return localDb.outbox_actions.where('sendState').equals('pending').count();
}

/** Actions parked awaiting a human decision. */
export async function getReconciliationActions(): Promise<OutboxActionRecord[]> {
  return localDb.outbox_actions.where('sendState').anyOf('rejected', 'quarantined').sortBy('createdAtMs');
}

// ---------------------------------------------------------------------------
// Recovery and manual reconciliation
// ---------------------------------------------------------------------------

/**
 * Clears `sending` rows left behind by a crash or a reload mid-flush.
 *
 * Must run at startup, before the engine sends anything: once a flush is
 * running, `sending` legitimately means "in flight right now" and resetting
 * it would let the same batch go out twice.
 */
export async function recoverInFlightActions(): Promise<number> {
  if (isFlushing) return 0;
  const stranded = await localDb.outbox_actions.where('sendState').equals('sending').toArray();
  const transitions = stranded
    .map(recoveryTransition)
    .filter((t): t is OutboxTransition => t !== null);
  await applyTransitions(transitions);
  return transitions.length;
}

/**
 * An explicit operator retry of a refused action, after the cause has been
 * addressed. Never applies to a quarantined one — see `manualRetryTransition`.
 */
export async function retryRejectedAction(clientActionId: string): Promise<boolean> {
  const action = await localDb.outbox_actions.get(clientActionId);
  if (!action) return false;

  const transition = manualRetryTransition(action);
  if (!transition) return false;

  await applyTransitions([transition]);
  notifyOutboxChanged();
  return true;
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/**
 * Sends one batch of retryable, correctly-owned actions.
 *
 * Deliberately not gated on `navigator.onLine`: that flag says the interface
 * is up, not that this server is reachable, and an explicit retry must always
 * be allowed to try. Pacing is the retry engine's job.
 */
export async function flushOutbox(): Promise<FlushOutcome> {
  if (isFlushing) return { kind: 'busy' };
  isFlushing = true;

  try {
    const owner = await currentOwner();

    const candidates = await localDb.outbox_actions.orderBy('sequence').toArray();
    const retryable = candidates.filter(isRetryable);

    // Ownership is checked before anything is sent. A mismatch parks the
    // action; it is never re-stamped with the current identity and never
    // deleted.
    const sendable: OutboxActionRecord[] = [];
    const quarantines: OutboxTransition[] = [];
    for (const action of retryable) {
      const transition = ownershipTransition(action, owner);
      if (transition) quarantines.push(transition);
      else sendable.push(action);
    }
    await applyTransitions(quarantines);

    const batch = sendable.slice(0, 100);
    if (batch.length === 0) return { kind: 'idle' };

    for (const action of batch) {
      await localDb.outbox_actions.update(action.clientActionId, {
        sendState: 'sending',
        attempts: action.attempts + 1,
      });
    }

    const payloadActions: ClientAction[] = batch.map((a) =>
      a.type === 'count'
        ? {
            clientActionId: a.clientActionId,
            sequence: a.sequence,
            type: 'count',
            direction: a.direction,
            clientCreatedAtMs: a.clientCreatedAtMs,
          }
        : {
            clientActionId: a.clientActionId,
            sequence: a.sequence,
            type: 'reversal',
            targetClientActionId: a.targetClientActionId,
            clientCreatedAtMs: a.clientCreatedAtMs,
          }
    );

    // What this device will still hold once this batch is acknowledged,
    // assuming every action in it succeeds. Actions already parked as
    // rejected or quarantined are *not* in the batch, so they stay counted
    // here — and the server adds back whatever it refuses in this round.
    const unresolvedBefore = await getUnresolvedActionsCount();
    const unresolvedAfterBatch = Math.max(unresolvedBefore - batch.length, 0);

    let response: Response;
    try {
      response = await fetch('/api/v1/device/actions/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          actions: payloadActions,
          pendingCount: unresolvedAfterBatch,
          appVersion: CLIENT_APP_VERSION,
        }),
      });
    } catch (err) {
      // The request never got an answer. Every action goes back to pending:
      // `clientActionId` idempotence makes a re-send safe even in the case
      // where the server did receive and apply it.
      const errorCode = 'NETWORK_ERROR';
      await applyTransitions(batch.map((a) => networkFailureTransition(a, errorCode)));
      console.debug('Outbox batch could not be delivered, will retry:', err);
      return { kind: 'failed', errorCode };
    }

    if (!response.ok) {
      // An HTTP-level failure says nothing about individual actions: the
      // server never reported per-action outcomes, so none of them may be
      // treated as refused. They return to pending and the engine backs off.
      const errorCode = `HTTP_${response.status}`;
      await applyTransitions(batch.map((a) => networkFailureTransition(a, errorCode)));
      return { kind: 'failed', errorCode };
    }

    const data: BatchSyncResponse = await response.json();
    const acknowledged: ActionAcknowledgment[] = data.acknowledged ?? [];

    await applyTransitions(acknowledged.map(acknowledgmentTransition));

    // An action that was sent but came back unmentioned has no verdict, so
    // it must not stay stuck in `sending`.
    const answered = new Set(acknowledged.map((ack) => ack.clientActionId));
    const unanswered = batch.filter((a) => !answered.has(a.clientActionId));
    await applyTransitions(unanswered.map((a) => networkFailureTransition(a, 'NO_ACKNOWLEDGMENT')));

    // A batch response carries the authoritative state too, and it goes
    // through the same funnel as bootstrap and SSE. `owner` is non-null
    // here: an action only becomes sendable once its owner matched.
    if (data.state && owner) {
      await persistAuthoritativeState(owner.eventId, data.state, 'batch');
    }

    const applied = acknowledged.filter((a) => a.status === 'applied' || a.status === 'duplicate').length;
    const rejected = acknowledged.filter((a) => a.status === 'rejected').length;
    return { kind: 'sent', applied, rejected };
  } finally {
    isFlushing = false;
  }
}
