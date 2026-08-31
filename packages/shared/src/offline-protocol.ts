import { z } from 'zod';

export const DirectionSchema = z.enum(['a_to_b', 'b_to_a']);
export type Direction = z.infer<typeof DirectionSchema>;

export const ActionTypeSchema = z.enum(['count', 'reversal']);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ClientCountActionSchema = z.object({
  clientActionId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  type: z.literal('count'),
  direction: DirectionSchema,
  clientCreatedAtMs: z.number().int().positive(),
});
export type ClientCountAction = z.infer<typeof ClientCountActionSchema>;

export const ClientReversalActionSchema = z.object({
  clientActionId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  type: z.literal('reversal'),
  targetClientActionId: z.string().uuid(),
  clientCreatedAtMs: z.number().int().positive(),
});
export type ClientReversalAction = z.infer<typeof ClientReversalActionSchema>;

export const ClientActionSchema = z.discriminatedUnion('type', [
  ClientCountActionSchema,
  ClientReversalActionSchema,
]);
export type ClientAction = z.infer<typeof ClientActionSchema>;

export const BatchSyncRequestSchema = z.object({
  actions: z.array(ClientActionSchema).max(100),
  lastSeenEventVersion: z.number().int().optional(),
  pendingCount: z.number().int().nonnegative().optional(),
  appVersion: z.string().max(50).optional(),
});
export type BatchSyncRequest = z.infer<typeof BatchSyncRequestSchema>;

export interface ActionAcknowledgment {
  clientActionId: string;
  status: 'applied' | 'duplicate' | 'rejected';
  movementId?: number;
  errorCode?: string;
}

export interface CompactSpaceState {
  id: string;
  name: string;
  kind: 'leaf' | 'aggregate' | 'external';
  occupancy: number;
  capacity: number | null;
}

export interface CompactEventState {
  version: number;
  eventStatus: 'draft' | 'live' | 'closing' | 'closed' | 'archived';
  eventOccupancy: number;
  eventCapacity: number;
  spaces: CompactSpaceState[];
  serverTimeMs: number;
}

export interface BatchSyncResponse {
  acknowledged: ActionAcknowledgment[];
  state: CompactEventState;
}

/**
 * Where a queued action stands in its journey to the server.
 *
 *  - `pending`     the engine may send it now;
 *  - `sending`     in flight. Persisted, so finding one at startup means the
 *                  app died mid-flush and the acknowledgment is *uncertain*:
 *                  the action may or may not have been applied. Idempotence
 *                  on `clientActionId` makes a re-send safe, so recovery
 *                  puts it back to `pending`;
 *  - `rejected`    the server refused it deterministically. Retrying changes
 *                  nothing until a human fixes the cause, so the engine must
 *                  never send it on its own — but it is never deleted either;
 *  - `quarantined` it belongs to an identity that is no longer this device's
 *                  (a previous pairing, or a legacy row that carries no
 *                  identity at all). Sending it would attribute a count to
 *                  the wrong session, event or checkpoint, so it waits for
 *                  an explicit reconciliation.
 *
 * Only `applied` and `duplicate` acknowledgments remove a row. Everything
 * else keeps it: an operator's counting intent is never dropped to make a
 * dashboard look clean.
 */
export type OutboxSendState = 'pending' | 'sending' | 'rejected' | 'quarantined';

/**
 * The identity that produced an action.
 *
 * The batch endpoint derives event, checkpoint and device session from the
 * *current* cookie, so an untagged action queued under one pairing would be
 * silently applied under the next one. Stamping the origin at enqueue time
 * is what lets the client refuse that.
 */
export interface OutboxActionOwner {
  deviceSessionId: string;
  eventId: string;
  checkpointId: string;
}

export type OutboxActionRecord = ClientAction & {
  attempts: number;
  sendState: OutboxSendState;
  lastErrorCode?: string;
  createdAtMs: number;
  /**
   * Absent only on rows written by a build that predates ownership
   * tagging. Such rows are quarantined on migration — never attributed to
   * whichever device happens to be paired now.
   */
  owner?: OutboxActionOwner;
};

/** Client-side error codes, i.e. refusals no server round-trip produced. */
export const OUTBOX_LOCAL_ERROR_CODES = {
  /** The action's owner is not the identity currently paired on this device. */
  SESSION_CHANGED: 'SESSION_CHANGED',
  /** A pre-ownership row: its origin cannot be established, only guessed. */
  OWNER_UNKNOWN: 'OWNER_UNKNOWN',
  /** The flush died mid-flight; the acknowledgment was never seen. */
  UNCERTAIN_ACK: 'UNCERTAIN_ACK',
} as const;
