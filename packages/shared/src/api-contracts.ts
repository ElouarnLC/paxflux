import { z } from 'zod';
import { StaffUser, EventModel, SpaceModel, CheckpointModel, DeviceSessionModel, SyncQuality } from './models.js';
import { CompactEventState } from './offline-protocol.js';

// Setup
export const SetupRequestSchema = z.object({
  setupToken: z.string().min(16).max(128),
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(8).max(128),
  instanceName: z.string().min(1).max(100).optional(),
});
export type SetupRequest = z.infer<typeof SetupRequestSchema>;

// Auth Login
export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export interface AuthSessionResponse {
  user: StaffUser;
  csrfToken: string;
}

// Meta
export interface MetaResponse {
  isInitialized: boolean;
  instanceName: string;
  version: string;
  apiVersion: string;
  buildId?: string;
  serverTimeMs: number;
}

// Events
export const CreateEventRequestSchema = z.object({
  name: z.string().min(1).max(120),
  timezone: z.string().min(1).max(50).default('Europe/Paris'),
  capacity: z.number().int().min(0),
  warningRatio1: z.number().min(0).max(1).default(0.80),
  warningRatio2: z.number().min(0).max(1).default(0.90),
  startsAtMs: z.number().int().positive().nullable().optional(),
  endsAtMs: z.number().int().positive().nullable().optional(),
});
export type CreateEventRequest = z.infer<typeof CreateEventRequestSchema>;

export const UpdateEventRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  capacity: z.number().int().min(0).optional(),
  warningRatio1: z.number().min(0).max(1).optional(),
  warningRatio2: z.number().min(0).max(1).optional(),
  startsAtMs: z.number().int().positive().nullable().optional(),
  endsAtMs: z.number().int().positive().nullable().optional(),
});
export type UpdateEventRequest = z.infer<typeof UpdateEventRequestSchema>;

// Spaces
export const CreateSpaceRequestSchema = z.object({
  name: z.string().min(1).max(100),
  kind: z.enum(['leaf', 'aggregate', 'external']),
  parentId: z.string().uuid().nullable().optional(),
  capacity: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int().default(0),
});
export type CreateSpaceRequest = z.infer<typeof CreateSpaceRequestSchema>;

export const UpdateSpaceRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  parentId: z.string().uuid().nullable().optional(),
  capacity: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateSpaceRequest = z.infer<typeof UpdateSpaceRequestSchema>;

// Checkpoints
export const CreateCheckpointRequestSchema = z.object({
  name: z.string().min(1).max(100),
  spaceAId: z.string().uuid(),
  spaceBId: z.string().uuid(),
  allowAToB: z.boolean().default(true),
  allowBToA: z.boolean().default(true),
  labelAToB: z.string().min(1).max(50),
  labelBToA: z.string().min(1).max(50),
  sortOrder: z.number().int().default(0),
});
export type CreateCheckpointRequest = z.infer<typeof CreateCheckpointRequestSchema>;

export const UpdateCheckpointRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  allowAToB: z.boolean().optional(),
  allowBToA: z.boolean().optional(),
  labelAToB: z.string().min(1).max(50).optional(),
  labelBToA: z.string().min(1).max(50).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCheckpointRequest = z.infer<typeof UpdateCheckpointRequestSchema>;

// Device Invites & Pairing
export const CreateDeviceInviteRequestSchema = z.object({
  checkpointId: z.string().uuid(),
  expiresInMinutes: z.number().int().min(1).max(1440).default(30),
});
export type CreateDeviceInviteRequest = z.infer<typeof CreateDeviceInviteRequestSchema>;

export interface CreateDeviceInviteResponse {
  id: string;
  checkpointId: string;
  token: string; // Plaintext token returned once for QR generation
  pairUrl: string;
  expiresAtMs: number;
}

export const PairDeviceRequestSchema = z.object({
  token: z.string().min(16).max(128),
  appVersion: z.string().max(50).optional(),
});
export type PairDeviceRequest = z.infer<typeof PairDeviceRequestSchema>;

export interface DeviceBootstrapResponse {
  event: {
    id: string;
    name: string;
    status: string;
    capacity: number;
  };
  checkpoint: {
    id: string;
    name: string;
    spaceAId: string;
    spaceBId: string;
    spaceAName: string;
    spaceBName: string;
    labelAToB: string;
    labelBToA: string;
    allowAToB: boolean;
    allowBToA: boolean;
  };
  deviceSession: {
    id: string;
    label: string;
  };
  state: CompactEventState;
}

export const DeviceHeartbeatRequestSchema = z.object({
  pendingCount: z.number().int().nonnegative().default(0),
  lastClientSequence: z.number().int().nonnegative().optional(),
  appVersion: z.string().max(50).optional(),
});
export type DeviceHeartbeatRequest = z.infer<typeof DeviceHeartbeatRequestSchema>;

// Supervisor Adjustments
export const CreateAdjustmentRequestSchema = z.object({
  spaceId: z.string().uuid(),
  observedCount: z.number().int().min(0),
  reason: z.string().min(3).max(500),
});
export type CreateAdjustmentRequest = z.infer<typeof CreateAdjustmentRequestSchema>;

export interface PreflightResponse {
  ready: boolean;
  error: { code: string; message: string } | null;
}

export interface EventDetailResponse {
  event: EventModel;
  spaces: SpaceModel[];
  checkpoints: CheckpointModel[];
  occupancy: {
    global: number;
    spaces: Record<string, number>;
  };
  devices: Array<{
    id: string;
    checkpointId: string;
    checkpointName: string;
    label: string;
    isOnline: boolean;
    lastSeenAtMs: number | null;
    lastPendingCount: number;
    appVersion: string | null;
  }>;
  syncQuality: SyncQuality;
}

export interface AnalyticsResponse {
  eventId: string;
  currentOccupancy: number;
  capacity: number;
  peakOccupancy: number;
  peakOccupancyTimeMs: number | null;
  totalEntries: number;
  totalExits: number;
  netDelta: number;
  flowRecent5Min: {
    entries: number;
    exits: number;
    netDelta: number;
  };
  checkpointStats: Array<{
    checkpointId: string;
    checkpointName: string;
    entries: number;
    exits: number;
  }>;
  spaceStats: Array<{
    spaceId: string;
    spaceName: string;
    occupancy: number;
    capacity: number | null;
  }>;
  timeline: Array<{
    timestampMs: number;
    occupancy: number;
    entries: number;
    exits: number;
  }>;
}

export interface SystemStatusResponse {
  version: string;
  buildId?: string;
  nodeVersion: string;
  uptimeSeconds: number;
  database: {
    sizeBytes: number;
    walSizeBytes: number;
    quickCheckOk: boolean;
    lastBackupTimeMs: number | null;
  };
  connectedSSECount: number;
  activeEventsCount: number;
}
