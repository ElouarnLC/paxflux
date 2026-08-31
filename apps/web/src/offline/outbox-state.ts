import {
  ActionAcknowledgment,
  OutboxActionOwner,
  OutboxActionRecord,
  OUTBOX_LOCAL_ERROR_CODES,
} from '@paxflux/shared';

/**
 * The outbox state machine, as pure decisions.
 *
 * Every rule about what happens to a queued action lives here rather than
 * being inlined in the flush loop, so it can be tested without IndexedDB and
 * so there is exactly one place that decides when an action may be deleted.
 *
 * The governing rule: an action leaves the outbox only on `applied` or
 * `duplicate`. Every other outcome keeps it, in a state that says why.
 */

export type OutboxTransition =
  | { kind: 'delete'; clientActionId: string; reason: 'applied' | 'duplicate' }
  | { kind: 'update'; clientActionId: string; changes: Partial<OutboxActionRecord> };

/** True when the engine is allowed to send this action on its own. */
export function isRetryable(action: Pick<OutboxActionRecord, 'sendState'>): boolean {
  return action.sendState === 'pending';
}

/**
 * True when this action still stands between the device and "fully synced".
 *
 * Every row in the outbox qualifies — including `rejected` and `quarantined`
 * ones, which the engine will never send by itself. Reporting only the
 * retryable ones would tell a supervisor a device is drained while it still
 * holds counts nobody has reconciled, and would let a normal `/close`
 * through.
 */
export function isUnresolved(_action: Pick<OutboxActionRecord, 'sendState'>): boolean {
  return true;
}

/** True when this action needs a human before it can move again. */
export function needsReconciliation(action: Pick<OutboxActionRecord, 'sendState'>): boolean {
  return action.sendState === 'rejected' || action.sendState === 'quarantined';
}

export function sameOwner(a: OutboxActionOwner | undefined, b: OutboxActionOwner | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.deviceSessionId === b.deviceSessionId && a.eventId === b.eventId && a.checkpointId === b.checkpointId
  );
}

/**
 * Decides what to do with an action given the identity currently paired.
 *
 * A mismatch is never resolved by rewriting the action's owner: that would
 * attribute a count made at one door, under one session, to another. The
 * action is parked instead, and a human decides.
 */
export function ownershipTransition(
  action: OutboxActionRecord,
  currentOwner: OutboxActionOwner | null
): OutboxTransition | null {
  if (!action.owner) {
    return {
      kind: 'update',
      clientActionId: action.clientActionId,
      changes: { sendState: 'quarantined', lastErrorCode: OUTBOX_LOCAL_ERROR_CODES.OWNER_UNKNOWN },
    };
  }
  if (!currentOwner || !sameOwner(action.owner, currentOwner)) {
    return {
      kind: 'update',
      clientActionId: action.clientActionId,
      changes: { sendState: 'quarantined', lastErrorCode: OUTBOX_LOCAL_ERROR_CODES.SESSION_CHANGED },
    };
  }
  return null;
}

/**
 * Maps one server acknowledgment to its local consequence.
 *
 * `duplicate` is a success, not a problem: it is the answer to a re-send
 * whose first attempt was applied but whose response never arrived, and
 * deleting on it is precisely what stops ADR-005's lost-ACK case from
 * becoming a double count.
 */
export function acknowledgmentTransition(ack: ActionAcknowledgment): OutboxTransition {
  if (ack.status === 'applied' || ack.status === 'duplicate') {
    return { kind: 'delete', clientActionId: ack.clientActionId, reason: ack.status };
  }
  return {
    kind: 'update',
    clientActionId: ack.clientActionId,
    changes: {
      sendState: 'rejected',
      lastErrorCode: ack.errorCode || 'REJECTED',
    },
  };
}

/**
 * An action that was in flight when the request failed for a transient
 * reason (no network, 5xx, a 401 that may just be a rotated cookie) goes
 * back to `pending`: the send never got an answer, so the engine may try
 * again. `clientActionId` idempotence makes that safe even if the server
 * did apply it.
 */
export function networkFailureTransition(
  action: OutboxActionRecord,
  errorCode: string
): OutboxTransition {
  return {
    kind: 'update',
    clientActionId: action.clientActionId,
    changes: { sendState: 'pending', lastErrorCode: errorCode },
  };
}

/**
 * A refusal that is about the *identity*, not the action: the device session
 * is gone, or the server refused the batch because the cookie names another
 * session. Retrying under the credentials this device currently holds cannot
 * succeed, so the action leaves auto-retry — but it is kept, because it is a
 * real count nobody has reconciled.
 */
export function terminalSessionTransition(
  action: OutboxActionRecord,
  errorCode: string
): OutboxTransition {
  return {
    kind: 'update',
    clientActionId: action.clientActionId,
    changes: { sendState: 'quarantined', lastErrorCode: errorCode },
  };
}

/**
 * A `sending` row found at startup: the app died mid-flush, so whether the
 * server applied it is unknown. Treat it as an uncertain acknowledgment and
 * make it retryable rather than leaving it stranded forever.
 */
export function recoveryTransition(action: OutboxActionRecord): OutboxTransition | null {
  if (action.sendState !== 'sending') return null;
  return {
    kind: 'update',
    clientActionId: action.clientActionId,
    changes: { sendState: 'pending', lastErrorCode: OUTBOX_LOCAL_ERROR_CODES.UNCERTAIN_ACK },
  };
}

/**
 * Puts a rejected action back in the queue after an operator has addressed
 * the cause. Quarantined actions are excluded on purpose: retrying one would
 * send it under the identity currently paired, which is the very thing the
 * quarantine exists to prevent.
 */
export function manualRetryTransition(action: OutboxActionRecord): OutboxTransition | null {
  if (action.sendState !== 'rejected') return null;
  return {
    kind: 'update',
    clientActionId: action.clientActionId,
    changes: { sendState: 'pending', lastErrorCode: undefined },
  };
}

/** Human-readable reason a count is stuck, for the counter's operator. */
export function describeOutboxError(errorCode: string | undefined): string {
  switch (errorCode) {
    case 'CHECKPOINT_NOT_FOUND':
      return 'Cette porte n’existe plus ou a été désactivée.';
    case 'DIRECTION_NOT_ALLOWED':
      return 'Ce sens de passage n’est plus autorisé sur cette porte.';
    case 'EVENT_NOT_LIVE':
      return 'L’événement n’acceptait plus de comptage au moment de l’envoi.';
    case 'EVENT_NOT_FOUND':
      return 'L’événement associé est introuvable.';
    case 'SPACE_NOT_FOUND':
      return 'Une des zones de cette porte est introuvable.';
    case 'ORIGINAL_MOVEMENT_NOT_FOUND':
      return 'Le comptage à annuler n’a jamais atteint le serveur.';
    case 'ALREADY_REVERSED':
      return 'Ce comptage a déjà été annulé.';
    case OUTBOX_LOCAL_ERROR_CODES.SESSION_CHANGED:
      return 'Comptage effectué sous un appairage précédent de cet appareil.';
    case OUTBOX_LOCAL_ERROR_CODES.OWNER_UNKNOWN:
      return 'Comptage enregistré par une version antérieure, sans identité d’appareil.';
    case OUTBOX_LOCAL_ERROR_CODES.DEVICE_SESSION_INVALID:
      return 'La session de cet appareil n’est plus valide. Un nouvel appairage est nécessaire.';
    case 'DEVICE_SESSION_MISMATCH':
    case OUTBOX_LOCAL_ERROR_CODES.SESSION_MISMATCH_REFUSED:
      return 'Le serveur a refusé ce comptage : il appartient à un autre appairage de cet appareil.';
    default:
      return errorCode
        ? `Refusé par le serveur (${errorCode}).`
        : 'Refusé par le serveur, sans code d’erreur.';
  }
}
