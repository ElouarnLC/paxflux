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
  /**
   * The device session the client believes it is sending under.
   *
   * Required, because the endpoint otherwise derives event, checkpoint and
   * session purely from the cookie. During a re-pairing there is a window
   * where the cookie already belongs to the new session while the client's
   * own stored configuration still describes the old one — and in that
   * window an unasserted batch is applied under the wrong identity. Sending
   * the expectation lets the server refuse the whole batch instead.
   */
  expectedDeviceSessionId: z.string().uuid(),
  lastSeenEventVersion: z.number().int().optional(),
  pendingCount: z.number().int().nonnegative().optional(),
  appVersion: z.string().max(50).optional(),
});
export type BatchSyncRequest = z.infer<typeof BatchSyncRequestSchema>;

/**
 * Runtime schemas for everything a device reads back from the server.
 *
 * These are not documentation: a batch response is the only thing that
 * decides whether a queued count is deleted, and a body that merely *parses*
 * as JSON is not evidence that it says what it appears to say. A truncated
 * or proxy-mangled 200 can easily yield `{ acknowledged: [{}], state: {} }`,
 * which a shape check based on `typeof` accepts and which would then delete
 * nothing, acknowledge nothing, and quietly persist an empty snapshot.
 *
 * The types below are inferred from the schemas so the two cannot drift.
 */

export const AcknowledgmentStatusSchema = z.enum(['applied', 'duplicate', 'rejected']);

export const ActionAcknowledgmentSchema = z.object({
  clientActionId: z.string().uuid(),
  status: AcknowledgmentStatusSchema,
  movementId: z.number().int().positive().optional(),
  errorCode: z.string().min(1).max(120).optional(),
});
export type ActionAcknowledgment = z.infer<typeof ActionAcknowledgmentSchema>;

export const SpaceKindSchema = z.enum(['leaf', 'aggregate', 'external']);

export const CompactSpaceStateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: SpaceKindSchema,
  occupancy: z.number().int(),
  capacity: z.number().int().nullable(),
});
export type CompactSpaceState = z.infer<typeof CompactSpaceStateSchema>;

export const EventStatusSchema = z.enum(['draft', 'live', 'closing', 'closed', 'archived']);

export const CompactEventStateSchema = z.object({
  version: z.number().int().nonnegative(),
  eventStatus: EventStatusSchema,
  eventOccupancy: z.number().int(),
  eventCapacity: z.number().int(),
  spaces: z.array(CompactSpaceStateSchema),
  serverTimeMs: z.number().int().positive(),
});
export type CompactEventState = z.infer<typeof CompactEventStateSchema>;

export const BatchSyncResponseSchema = z.object({
  acknowledged: z.array(ActionAcknowledgmentSchema),
  state: CompactEventStateSchema,
});
export type BatchSyncResponse = z.infer<typeof BatchSyncResponseSchema>;

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
  /** The device session is gone (revoked, expired). Terminal until re-pairing. */
  DEVICE_SESSION_INVALID: 'DEVICE_SESSION_INVALID',
  /** The server refused the batch: the cookie names a different session. */
  SESSION_MISMATCH_REFUSED: 'SESSION_MISMATCH_REFUSED',
  /** A 200 whose body could not be read as a batch response. */
  INVALID_BATCH_RESPONSE: 'INVALID_BATCH_RESPONSE',
} as const;

/**
 * The minimum kept about an action the server confirmed, so its undo stays
 * possible after it has left the outbox.
 *
 * SPEC §11.2 expects the last count to remain undoable once it is safely
 * synced; the acknowledgment lifecycle requires it to leave the outbox. This
 * record reconciles the two: enough to build the compensating reversal and
 * to project it locally, and nothing more.
 */
export interface ConfirmedActionRecord {
  clientActionId: string;
  type: 'count';
  direction: Direction;
  owner: OutboxActionOwner;
  /** Checkpoint endpoints as they stood, so a reversal projects correctly. */
  spaceAId: string;
  spaceBId: string;
  /** When the operator made the tap — the ordering key for "the last count". */
  clientCreatedAtMs: number;
  confirmedAtMs: number;
  /** Set once a reversal has been queued for it, so it is not offered twice. */
  reversedAtMs?: number;
}
