import { localDb } from './db.js';
import {
  ClientAction,
  OutboxActionRecord,
  OutboxActionOwner,
  Direction,
  BatchSyncResponse,
  BatchSyncResponseSchema,
  OUTBOX_LOCAL_ERROR_CODES,
} from '@paxflux/shared';
import { CLIENT_APP_VERSION } from '../version.js';
import { currentPairing, observedClosingEpoch, persistAuthoritativeState } from './snapshot.js';
import { getConfirmedActions, recordConfirmedAction } from './confirmed-actions.js';
import {
  OutboxTransition,
  acknowledgmentTransition,
  isRetryable,
  manualRetryTransition,
  networkFailureTransition,
  ownershipTransition,
  recoveryTransition,
  sameOwner,
  terminalSessionTransition,
  classifyBatchHttpStatus,
  deterministicFailureTransition,
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

/**
 * Allocates the next device sequence.
 *
 * Must be called from inside a transaction that also covers whatever the
 * sequence is being allocated *for*: a sequence consumed by a write that
 * then fails leaves a permanent gap, and worse, an allocation that succeeds
 * while its insert does not means the action the operator saw acknowledged
 * on screen was never queued at all.
 */
async function allocateSequence(): Promise<number> {
  const record = await localDb.meta.get('next_sequence');
  const current = typeof record?.value === 'number' ? record.value : 0;
  const next = current + 1;
  await localDb.meta.put({ key: 'next_sequence', value: next });
  return next;
}

/** Standalone allocation, for callers with nothing else to commit. */
export async function getNextSequence(): Promise<number> {
  return localDb.transaction('rw', localDb.meta, allocateSequence);
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
  const now = Date.now();

  // Sequence allocation and the insert commit together. Split apart, a
  // failure between them consumes a sequence for an action that was never
  // queued — the operator sees a tap counted on screen that no longer
  // exists anywhere.
  const record = await localDb.transaction('rw', localDb.meta, localDb.outbox_actions, async () => {
    const row: OutboxActionRecord = {
      clientActionId,
      sequence: await allocateSequence(),
      type: 'count',
      direction,
      clientCreatedAtMs: now,
      attempts: 0,
      sendState: 'pending',
      createdAtMs: now,
      owner,
    };
    await localDb.outbox_actions.add(row);
    return row;
  });

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
 *
 * Three rules hold for *every* target, queued or confirmed:
 *
 *  - the target must belong to the identity asking. Ownership was checked
 *    for confirmed counts only, which left a queued count made under a
 *    previous pairing deletable — and deleting one is losing a real count;
 *  - a target already reversed is refused, whether the existing reversal is
 *    still queued or the confirmed record is stamped. Two compensating
 *    movements for one original would take the gauge below the truth;
 *  - a target that is neither queued nor remembered as confirmed is
 *    refused. Inventing a reversal towards something unknown produces
 *    `ORIGINAL_MOVEMENT_NOT_FOUND` at best, and at worst compensates a
 *    movement this device cannot vouch for.
 */
export async function enqueueReversalAction(
  targetClientActionId: string,
  owner: OutboxActionOwner
): Promise<ReversalOutcome> {
  const clientActionId = generateActionId();
  const now = Date.now();

  // One transaction over all three tables.
  //
  // The confirmed check, the sequence allocation, the reversal insert and
  // the `reversedAtMs` stamp are a single decision: marking a confirmed
  // count as reversed before its reversal is durably queued would leave the
  // operator with a count that is neither undone nor undoable — the undo
  // button gone and no compensating movement anywhere. Anything that
  // aborts leaves the confirmed count still undoable and no partial
  // reversal behind.
  const outcome = await localDb.transaction(
    'rw',
    localDb.confirmed_actions,
    localDb.meta,
    localDb.outbox_actions,
    async (): Promise<ReversalOutcome> => {
      const refused: ReversalOutcome = { kind: 'refused', reason: 'target_not_reconcilable' };

      // Already reversed? Read inside the transaction, so two undos racing
      // for the same target cannot both find it un-reversed.
      const existingReversal = await localDb.outbox_actions
        .filter((row) => row.type === 'reversal' && row.targetClientActionId === targetClientActionId)
        .first();
      if (existingReversal) return refused;

      const target = await localDb.outbox_actions.get(targetClientActionId);

      if (target) {
        // Ownership first, before anything is deleted or compensated: a
        // count queued under a previous pairing is not this identity's to
        // remove, and removing one loses a real count.
        if (!sameOwner(target.owner, owner)) return refused;
        if (target.sendState === 'quarantined' || target.sendState === 'rejected') return refused;
        if (target.type !== 'count') return refused;
      }

      // A tap that never left the device: nothing on the server to
      // compensate for, so it is simply removed.
      if (target && target.attempts === 0 && target.sendState === 'pending') {
        await localDb.outbox_actions.delete(targetClientActionId);
        return { kind: 'deleted_locally' };
      }

      // The target may have been acknowledged and deleted already — the
      // ordinary online case, which must stay undoable (SPEC §11.2).
      let confirmedToMark: string | null = null;
      if (!target) {
        const confirmed = await localDb.confirmed_actions.get(targetClientActionId);
        // Neither queued nor confirmed: this device has no basis for a
        // compensating movement, so it does not invent one.
        if (!confirmed) return refused;
        if (!sameOwner(confirmed.owner, owner) || confirmed.reversedAtMs !== undefined) return refused;
        confirmedToMark = targetClientActionId;
      }

      const record: OutboxActionRecord = {
        clientActionId,
        sequence: await allocateSequence(),
        type: 'reversal',
        targetClientActionId,
        clientCreatedAtMs: now,
        attempts: 0,
        sendState: 'pending',
        createdAtMs: now,
        owner,
      };
      await localDb.outbox_actions.add(record);

      // Stamped last, and only inside the same commit as the insert above.
      if (confirmedToMark) {
        const confirmed = await localDb.confirmed_actions.get(confirmedToMark);
        if (confirmed) {
          await localDb.confirmed_actions.put({ ...confirmed, reversedAtMs: now });
        }
      }

      return { kind: 'queued', record };
    }
  );

  if (outcome.kind !== 'refused') notifyOutboxChanged();
  return outcome;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * What the "annuler" button should act on, if anything.
 *
 * The candidate may be sitting in the outbox or already acknowledged and
 * remembered in the confirmed ring — the operator does not experience those
 * as different situations, and a count that synced quickly must not become
 * un-undoable for it.
 */
export type UndoCandidate =
  | { source: 'outbox'; clientActionId: string; direction: Direction; clientCreatedAtMs: number }
  | { source: 'confirmed'; clientActionId: string; direction: Direction; clientCreatedAtMs: number };

/**
 * The most recent count this pairing made that has not been undone and is
 * still actionable.
 *
 * Quarantined and rejected actions are excluded: offering "annuler" on a
 * count that belongs to a previous pairing, or that the server already
 * refused, would produce a reversal nobody can apply.
 */
export async function getLastCountAction(owner: OutboxActionOwner | null): Promise<UndoCandidate | null> {
  if (!owner) return null;

  const actions = await localDb.outbox_actions.toArray();

  const reversedTargets = new Set(
    actions
      .filter((a): a is OutboxActionRecord & { type: 'reversal' } => a.type === 'reversal')
      .map((a) => a.targetClientActionId)
  );

  const candidates: UndoCandidate[] = [];

  for (const action of actions) {
    if (action.type !== 'count') continue;
    if (action.sendState === 'quarantined' || action.sendState === 'rejected') continue;
    if (!sameOwner(action.owner, owner)) continue;
    if (reversedTargets.has(action.clientActionId)) continue;
    candidates.push({
      source: 'outbox',
      clientActionId: action.clientActionId,
      direction: action.direction,
      clientCreatedAtMs: action.clientCreatedAtMs,
    });
  }

  for (const confirmed of await getConfirmedActions(owner)) {
    if (confirmed.reversedAtMs !== undefined) continue;
    if (reversedTargets.has(confirmed.clientActionId)) continue;
    candidates.push({
      source: 'confirmed',
      clientActionId: confirmed.clientActionId,
      direction: confirmed.direction,
      clientCreatedAtMs: confirmed.clientCreatedAtMs,
    });
  }

  // Ordered by when the operator made the tap, so a queued action and an
  // acknowledged one compare on the same axis.
  candidates.sort((a, b) => b.clientCreatedAtMs - a.clientCreatedAtMs);
  return candidates[0] ?? null;
}

/**
 * Everything still standing between this device and "fully synced",
 * counting only what belongs to the identity currently paired.
 *
 * This is the number the heartbeat and the batch report. Quarantined actions
 * from a *previous* pairing are deliberately excluded: they are a real
 * reconciliation problem, but they are not this session's, and counting them
 * would let one device's abandoned queue block the closing of an event the
 * current session has fully drained.
 */
export async function getOwnerUnresolvedActionsCount(owner: OutboxActionOwner | null): Promise<number> {
  if (!owner) return 0;
  const actions = await localDb.outbox_actions.toArray();
  return actions.filter((action) => sameOwner(action.owner, owner)).length;
}

/**
 * Everything unresolved on this device, whoever made it.
 *
 * What the operator sees, as opposed to what the supervisor is told: a
 * previous pairing's stranded counts still need a human, and hiding them
 * locally would be how they get lost.
 */
export async function getLocalUnresolvedActionsCount(): Promise<number> {
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
    const pairing = await currentPairing();
    const owner = pairing?.owner ?? null;

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
    if (batch.length === 0 || !pairing) return { kind: 'idle' };

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
    // assuming every action in it succeeds — counting only actions owned by
    // the identity we are sending as. Actions already parked as rejected are
    // in that number; a previous pairing's stranded queue is not, since it
    // is not this session's to report. The server adds back whatever it
    // refuses in this round.
    const unresolvedBefore = await getOwnerUnresolvedActionsCount(owner);
    const unresolvedAfterBatch = Math.max(unresolvedBefore - batch.length, 0);

    let response: Response;
    try {
      response = await fetch('/api/v1/device/actions/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          actions: payloadActions,
          // The cookie says which session is authenticated; this says which
          // session the actions were queued under. During a re-pairing the
          // two can disagree, and the server refuses the batch rather than
          // applying one device's counts as another's.
          expectedDeviceSessionId: pairing.owner.deviceSessionId,
          // The closing epoch this device has seen. A normal close needs
          // every active session to have named the current one while
          // reporting nothing unresolved; naming nothing simply never
          // confirms, which is the safe direction.
          observedClosingStartedAtMs: await observedClosingEpoch(),
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
      const kind = classifyBatchHttpStatus(response.status, await isSessionMismatch(response));
      const errorCode =
        kind === 'terminal-session'
          ? OUTBOX_LOCAL_ERROR_CODES.DEVICE_SESSION_INVALID
          : kind === 'session-mismatch'
            ? OUTBOX_LOCAL_ERROR_CODES.SESSION_MISMATCH_REFUSED
            : `HTTP_${response.status}`;

      switch (kind) {
        case 'terminal-session':
        case 'session-mismatch':
          // These credentials, or this identity, cannot deliver the batch.
          // Kept out of auto-retry until a re-pairing, never deleted.
          await applyTransitions(batch.map((a) => terminalSessionTransition(a, errorCode)));
          break;
        case 'deterministic':
          // Understood and refused on its merits. Re-sending the same bytes
          // produces the same answer, so it waits for a human instead of
          // looping.
          await applyTransitions(batch.map((a) => deterministicFailureTransition(a, errorCode)));
          break;
        case 'retryable':
          // No verdict was expressed about the individual actions, so none
          // may be treated as refused. They return to pending and the
          // engine backs off.
          await applyTransitions(batch.map((a) => networkFailureTransition(a, errorCode)));
          break;
      }

      if (kind !== 'retryable') notifyOutboxChanged();
      return { kind: 'failed', errorCode };
    }

    // A 200 is only an acknowledgment if it *says* something valid.
    //
    // Parsing as JSON is not evidence: a truncated or proxy-mangled body can
    // yield `{ acknowledged: [{}], state: {} }`, which a `typeof` check
    // accepts and which would then delete nothing, acknowledge nothing, and
    // persist an empty snapshot over a good one. The shared schema is
    // applied in full, and the batch is treated as an uncertain ACK — all of
    // it, with no partial transitions — if anything does not hold.
    let data: BatchSyncResponse;
    try {
      const parsed: unknown = await response.json();
      const validated = BatchSyncResponseSchema.safeParse(parsed);
      if (!validated.success) {
        throw new Error(`Batch response failed validation: ${validated.error.issues[0]?.message ?? 'unknown'}`);
      }
      // An acknowledgment for something this device did not just send is
      // not an answer to this request. Acting on it would delete or refuse
      // an action on the strength of a response that never addressed it.
      const sentIds = new Set(batch.map((a) => a.clientActionId));
      const stray = validated.data.acknowledged.find((ack) => !sentIds.has(ack.clientActionId));
      if (stray) {
        throw new Error(`Batch response acknowledged an action outside the batch: ${stray.clientActionId}`);
      }
      data = validated.data;
    } catch (err) {
      const errorCode = OUTBOX_LOCAL_ERROR_CODES.INVALID_BATCH_RESPONSE;
      await applyTransitions(batch.map((a) => networkFailureTransition(a, errorCode)));
      console.debug('Batch response could not be trusted; treating it as an uncertain ACK:', err);
      return { kind: 'failed', errorCode };
    }

    const acknowledged = data.acknowledged;
    const byId = new Map(batch.map((a) => [a.clientActionId, a]));

    // Everything the acknowledgment implies, committed together.
    //
    // The counter's gauge is `authoritative + pendingDelta`, read from two
    // live queries: one over `outbox_actions`, one over `event_state`. Two
    // commits mean two renders, and the one in between is arithmetic that
    // was never true — the acknowledged action already gone from the outbox
    // while the state that absorbed it has not landed. On a single pending
    // entry the gauge visibly fell 1 → 0 → 1 as the ACK arrived; on the
    // other ordering it would read 1 → 2 → 1, the double jump. Dexie
    // publishes live queries at commit, so one transaction makes the
    // intermediate unobservable rather than merely unlikely.
    await localDb.transaction(
      'rw',
      localDb.outbox_actions,
      localDb.confirmed_actions,
      localDb.event_state,
      async () => {
        // Remember the counts the server confirmed *before* deleting them,
        // so undo survives the acknowledgment that removes them (SPEC §11.2).
        for (const ack of acknowledged) {
          if (ack.status !== 'applied' && ack.status !== 'duplicate') continue;
          const action = byId.get(ack.clientActionId);
          if (!action) continue;
          await recordConfirmedAction(action, { spaceAId: pairing.spaceAId, spaceBId: pairing.spaceBId });
        }

        await applyTransitions(acknowledged.map(acknowledgmentTransition));

        // An action that was sent but came back unmentioned has no verdict,
        // so it must not stay stuck in `sending`.
        const answered = new Set(acknowledged.map((ack) => ack.clientActionId));
        const unanswered = batch.filter((a) => !answered.has(a.clientActionId));
        await applyTransitions(unanswered.map((a) => networkFailureTransition(a, 'NO_ACKNOWLEDGMENT')));

        // A batch response carries the authoritative state too, and it goes
        // through the same funnel as bootstrap and SSE — which opens its own
        // `rw` transaction on `event_state`, joining this one. Its staleness
        // guard is unchanged and still decides whether the frame is stored.
        if (data.state) {
          await persistAuthoritativeState(pairing.owner.eventId, data.state, 'batch');
        }
      }
    );

    notifyOutboxChanged();

    const applied = acknowledged.filter((a) => a.status === 'applied' || a.status === 'duplicate').length;
    const rejected = acknowledged.filter((a) => a.status === 'rejected').length;
    return { kind: 'sent', applied, rejected };
  } finally {
    isFlushing = false;
  }
}

/** Whether a 409 is the server refusing the batch on session identity. */
async function isSessionMismatch(response: Response): Promise<boolean> {
  try {
    const problem: unknown = await response.clone().json();
    return (
      typeof problem === 'object' &&
      problem !== null &&
      (problem as { code?: unknown }).code === 'DEVICE_SESSION_MISMATCH'
    );
  } catch (err) {
    console.debug('Could not read the 409 problem details:', err);
    return false;
  }
}
