export type StaffRole = 'admin' | 'supervisor';

export interface StaffUser {
  id: string;
  username: string;
  usernameNormalized: string;
  displayName: string | null;
  role: StaffRole;
  isActive: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  lastLoginAtMs: number | null;
}

export type EventStatus = 'draft' | 'live' | 'closing' | 'closed' | 'archived';

export interface EventModel {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  capacity: number;
  status: EventStatus;
  warningRatio1: number;
  warningRatio2: number;
  startsAtMs: number | null;
  endsAtMs: number | null;
  liveStartedAtMs: number | null;
  closingStartedAtMs: number | null;
  closedAtMs: number | null;
  archivedAtMs: number | null;
  version: number;
  topologyLockedAtMs: number | null;
  createdBy: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export type SpaceKind = 'leaf' | 'aggregate' | 'external';

export interface SpaceModel {
  id: string;
  eventId: string;
  parentId: string | null;
  name: string;
  kind: SpaceKind;
  capacity: number | null;
  sortOrder: number;
  isActive: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SpaceStateModel {
  eventId: string;
  spaceId: string;
  occupancy: number;
  updatedAtMs: number;
}

export interface CheckpointModel {
  id: string;
  eventId: string;
  name: string;
  spaceAId: string;
  spaceBId: string;
  allowAToB: boolean;
  allowBToA: boolean;
  labelAToB: string;
  labelBToA: string;
  sortOrder: number;
  isActive: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DeviceInviteModel {
  id: string;
  eventId: string;
  checkpointId: string;
  expiresAtMs: number;
  createdBy: string;
  createdAtMs: number;
  usedAtMs: number | null;
  revokedAtMs: number | null;
}

export interface DeviceSessionModel {
  id: string;
  eventId: string;
  checkpointId: string;
  label: string;
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  lastSeenAtMs: number | null;
  lastPendingCount: number;
  lastClientSequence: number | null;
  appVersion: string | null;
}

export type MovementKind = 'count' | 'reversal' | 'adjustment';
export type MovementSource = 'online' | 'offline_batch' | 'staff';

export interface MovementModel {
  id: number;
  eventId: string;
  checkpointId: string | null;
  deviceSessionId: string | null;
  actorUserId: string | null;
  kind: MovementKind;
  clientActionId: string | null;
  deviceSequence: number | null;
  fromSpaceId: string | null;
  toSpaceId: string | null;
  quantity: number;
  reversesMovementId: number | null;
  reason: string | null;
  clientTimeMs: number | null;
  serverTimeMs: number;
  eventVersion: number;
  source: MovementSource;
}

export interface AuditLogModel {
  id: number;
  eventId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  createdAtMs: number;
}

export interface BackupRecordModel {
  id: number;
  filename: string;
  reason: string;
  sizeBytes: number;
  sha256: string;
  quickCheckOk: boolean;
  createdAtMs: number;
}

export type SyncQuality = 'reliable' | 'degraded' | 'uncertain';
