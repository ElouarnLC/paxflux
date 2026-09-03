import { z } from 'zod';
import { StaffUser, EventModel, SpaceModel, SpaceKind, CheckpointModel, SyncQuality } from './models.js';
import { FALLBACK_TIMEZONE, TimezoneSchema } from './timezone.js';
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
  // A real IANA zone, not a free string: an event's day boundaries and its
  // exports are drawn in it, and a fixed offset would be an hour wrong for
  // half the year.
  timezone: TimezoneSchema.default(FALLBACK_TIMEZONE),
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
  /**
   * Changeable only while the event is a draft, and only to a real IANA zone.
   *
   * Deliberately laxer here than at creation, and the route is what tightens
   * it. Events created before RC2-C could store any 1–50 character string,
   * `GMT` and `EST` among them, and a schema that rejected those outright
   * would make such an event uneditable: every save resends the timezone,
   * so a legacy value would block a rename. So the schema accepts what the
   * column accepts, and the route requires IANA validity only when the value
   * actually *changes* — an unchanged legacy zone rides along, a new one
   * never does. Creation stays strict (`CreateEventRequestSchema`).
   *
   * Once counting has started the timezone is the frame every recorded
   * movement has already been read in; moving it would silently redraw the
   * day boundaries of a ledger that is append-only by design, so the route
   * refuses a change past `draft` with `TIMEZONE_LOCKED`.
   */
  timezone: z.string().min(1).max(50).optional(),
  warningRatio1: z.number().min(0).max(1).optional(),
  warningRatio2: z.number().min(0).max(1).optional(),
  startsAtMs: z.number().int().positive().nullable().optional(),
  endsAtMs: z.number().int().positive().nullable().optional(),
  /**
   * A precondition, not a field: reject this write unless the event is still
   * a draft when it is applied.
   *
   * The draft editor always sends it. Without it a stale editor — opened on
   * a draft, left open while somebody else started the event — could still
   * PATCH a live event's name and capacity, because this route legitimately
   * allows exactly that for the supervision surface. The server checks it
   * inside the same SQLite transaction that writes, so a refetch immediately
   * before the request cannot substitute for it.
   */
  expectedStatus: z.literal('draft').optional(),
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
  /**
   * The endpoints this door connects.
   *
   * Editable while the event is a draft so an operator can correct a door
   * they wired to the wrong zone, rather than deleting and recreating it —
   * which would churn an id that device invites and sessions already point
   * at. The route re-runs the full creation-time topology validation against
   * the *proposed* endpoints, and refuses outright while a device is paired
   * to this checkpoint: the paired counter caches these endpoints and
   * projects its taps across them, so changing them under it would silently
   * change what its taps mean.
   */
  spaceAId: z.string().uuid().optional(),
  spaceBId: z.string().uuid().optional(),
  allowAToB: z.boolean().optional(),
  allowBToA: z.boolean().optional(),
  labelAToB: z.string().min(1).max(50).optional(),
  labelBToA: z.string().min(1).max(50).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCheckpointRequest = z.infer<typeof UpdateCheckpointRequestSchema>;

// Atomic event-draft creation (Phase 4 — event + full topology in one
// transaction). Spaces reference each other (parent/child) and checkpoints
// reference their endpoint spaces via a client-supplied `clientId`, stable
// only within this one payload, since none of them have a server id yet.
export const DraftSpaceInputSchema = z.object({
  clientId: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  kind: z.enum(['leaf', 'aggregate', 'external']),
  parentClientId: z.string().min(1).max(64).nullable().optional(),
  capacity: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int().default(0),
});
export type DraftSpaceInput = z.infer<typeof DraftSpaceInputSchema>;

export const DraftCheckpointInputSchema = z.object({
  name: z.string().min(1).max(100),
  spaceAClientId: z.string().min(1).max(64),
  spaceBClientId: z.string().min(1).max(64),
  allowAToB: z.boolean().default(true),
  allowBToA: z.boolean().default(true),
  labelAToB: z.string().min(1).max(50),
  labelBToA: z.string().min(1).max(50),
  sortOrder: z.number().int().default(0),
});
export type DraftCheckpointInput = z.infer<typeof DraftCheckpointInputSchema>;

export const CreateEventDraftRequestSchema = z.object({
  event: CreateEventRequestSchema,
  spaces: z.array(DraftSpaceInputSchema).min(1).max(64),
  checkpoints: z.array(DraftCheckpointInputSchema).max(128).default([]),
});
export type CreateEventDraftRequest = z.infer<typeof CreateEventDraftRequestSchema>;

export interface CreateEventDraftResponse {
  event: EventModel;
  spaces: SpaceModel[];
  checkpoints: CheckpointModel[];
}

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
  /**
   * The canonical pairing URL, built server-side from PUBLIC_BASE_URL when
   * set and from the request origin otherwise. Clients must encode and
   * display this value as-is — rebuilding it from `window.location` yields
   * a QR that only works from wherever the admin happens to be browsing.
   */
  pairUrl: string;
  pairUrlSource: 'public_base_url' | 'request_origin';
  /** True when pairUrl resolves to a loopback address a phone cannot reach. */
  unreachableFromPhone: boolean;
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
  // Required, with no default: a heartbeat exists to report what this
  // device still holds. Defaulting a missing value to 0 would let an empty
  // or malformed body silently overwrite `lastPendingCount` and tell the
  // supervisor a device is fully synced when it may not be.
  pendingCount: z.number().int().nonnegative(),
  /**
   * The device session this report is about, asserted by the client.
   *
   * Same reasoning as the batch endpoint: the cookie says which session is
   * authenticated, not which session the client believes it is. During a
   * re-pairing those disagree, and a heartbeat sent in that window would
   * write one device's pending count onto another's session — telling the
   * supervisor the new device is holding counts it never made.
   */
  expectedDeviceSessionId: z.string().uuid(),
  /**
   * The closing epoch this device has seen. Same fail-closed rule as the
   * batch endpoint: absence never confirms a drain.
   */
  observedClosingStartedAtMs: z.number().int().positive().nullable().optional(),
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

/**
 * One active device as the supervision surfaces see it. `isOnline` is
 * computed server-side against DEVICE_ONLINE_THRESHOLD_MS so every client
 * shows the same verdict rather than its own approximation.
 */
export interface EventDeviceSummary {
  id: string;
  checkpointId: string;
  checkpointName: string;
  label: string;
  isOnline: boolean;
  lastSeenAtMs: number | null;
  lastPendingCount: number;
  appVersion: string | null;
}

export interface EventDetailResponse {
  event: EventModel;
  spaces: SpaceModel[];
  checkpoints: CheckpointModel[];
  occupancy: {
    global: number;
    spaces: Record<string, number>;
  };
  devices: EventDeviceSummary[];
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
    /**
     * What kind of space this row describes.
     *
     * Added because a client cannot otherwise tell an operational zone from
     * the `external` sentinel, which exists to give boundary movements a
     * counterpart and whose occupancy is structurally meaningless — it is
     * always 0 and is never counted into `eventOccupancy`. Rendering it as a
     * zone holding zero people invites an operator to read "the outside is
     * empty". The alternative was to infer it from the space's *name*, which
     * is operator-chosen text.
     */
    kind: SpaceKind;
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
