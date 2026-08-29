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

export type OutboxActionRecord = ClientAction & {
  attempts: number;
  sendState: 'pending' | 'sending' | 'acknowledged' | 'failed';
  lastErrorCode?: string;
  createdAtMs: number;
};
