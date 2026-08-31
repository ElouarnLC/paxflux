import { AppDb } from '../db/index.js';
import { events, spaces, spaceState, deviceSessions, checkpoints } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import { EventStatus, SpaceModel, CheckpointModel, CompactEventState, DEVICE_OFFLINE_THRESHOLD_MS } from '@paxflux/shared';
import { validateCheckpointRules } from './checkpoints.js';
import { calculateAggregateOccupancy } from './spaces.js';

export interface UnsyncedDevice {
  deviceId: string;
  checkpointName: string;
  label: string;
  isOnline: boolean;
  pendingCount: number;
  /** True when this session has acknowledged the current closing epoch. */
  confirmedDrainForEpoch: boolean;
}

/**
 * Active (non-revoked) devices that have not confirmed being drained for
 * the closing epoch currently in progress.
 *
 * SPEC §5.4 allows a normal `closing -> closed` transition only once every
 * active device has synced, and "has synced" has to mean something a device
 * actually said about *this* epoch. Deriving it from the last report — a
 * device that looked online with nothing pending — is not enough: that
 * report may predate the closing transition, and everything the device did
 * afterwards (a last count, a network cut) is invisible in it. A report
 * that arrives late but was prepared before the transition is the same
 * problem wearing a fresh `lastSeenAtMs`.
 *
 * So the gate reads an acknowledgment the device named explicitly: the
 * epoch value it echoed back while reporting nothing unresolved. Anything
 * else — silence, an older epoch, a non-zero count — leaves the device
 * blocking, and `force-close` remains the deliberate way past it.
 */
export async function getUnsyncedActiveDevices(db: AppDb, eventId: string): Promise<UnsyncedDevice[]> {
  const now = Date.now();
  const eventRecord = await db.select().from(events).where(eq(events.id, eventId)).get();
  const closingStartedAtMs = eventRecord?.closingStartedAtMs ?? null;

  const rows = await db
    .select({ device: deviceSessions, checkpoint: checkpoints })
    .from(deviceSessions)
    .innerJoin(checkpoints, eq(deviceSessions.checkpointId, checkpoints.id))
    .where(and(eq(deviceSessions.eventId, eventId), isNull(deviceSessions.revokedAtMs)))
    .all();

  return rows
    .map(({ device, checkpoint }) => ({
      deviceId: device.id,
      checkpointName: checkpoint.name,
      label: device.label,
      isOnline: device.lastSeenAtMs !== null && now - device.lastSeenAtMs <= DEVICE_OFFLINE_THRESHOLD_MS,
      pendingCount: device.lastPendingCount,
      confirmedDrainForEpoch:
        closingStartedAtMs !== null && device.drainedForClosingAtMs === closingStartedAtMs,
    }))
    .filter((d) => !d.confirmedDrainForEpoch);
}

/**
 * The drain acknowledgment a device report earns, if any.
 *
 * Returned rather than written here so the caller can apply it in the same
 * update as the rest of the report: a confirmation and the count it is
 * based on must never be stored apart.
 *
 * Every report either grants the acknowledgment or clears it. That is
 * deliberate — a device saying "I still hold something" revokes an earlier
 * confirmation, and a report that names no epoch (an older client, or one
 * prepared before the transition) never grants one.
 */
export function resolveDrainAcknowledgment(
  event: { status: string; closingStartedAtMs: number | null },
  observedClosingStartedAtMs: number | null | undefined,
  unresolvedCount: number
): number | null {
  if (event.status !== 'closing' || event.closingStartedAtMs === null) return null;
  if (observedClosingStartedAtMs !== event.closingStartedAtMs) return null;
  if (unresolvedCount !== 0) return null;
  return event.closingStartedAtMs;
}

export interface LifecycleValidationError {
  code: string;
  message: string;
}

export function isValidStatusTransition(current: EventStatus, next: EventStatus, isAdmin: boolean = false): boolean {
  if (current === next) return true;

  switch (current) {
    case 'draft':
      return next === 'live';
    case 'live':
      // draft -> live -> closing -> closed -> archived: `closing` is the
      // only mandatory drain step. A live event can never close directly
      // (see SPEC §5.3/§5.4) — /close only ever accepts `closing`.
      return next === 'closing';
    case 'closing':
      return next === 'closed' || next === 'live';
    case 'closed':
      return next === 'archived' || (isAdmin && next === 'live');
    case 'archived':
      return false; // Read-only
    default:
      return false;
  }
}

export function validateEventForLive(
  event: { capacity: number },
  spacesList: SpaceModel[],
  checkpointsList: CheckpointModel[]
): LifecycleValidationError | null {
  if (event.capacity < 0) {
    return { code: 'INVALID_CAPACITY', message: 'Event capacity cannot be negative.' };
  }

  // SPEC: boundary counting requires an external space at all times — a
  // topology that had one at creation but had it deactivated afterwards
  // (via PATCH) is no longer coherent, even if it was valid when created.
  const activeExternalSpaces = spacesList.filter((s) => s.kind === 'external' && s.isActive);
  if (activeExternalSpaces.length === 0) {
    return {
      code: 'NO_ACTIVE_EXTERNAL_SPACE',
      message: 'The event must have at least one active external (boundary) space.',
    };
  }

  const internalLeaves = spacesList.filter((s) => s.kind === 'leaf' && s.isActive);
  if (internalLeaves.length === 0) {
    return {
      code: 'NO_INTERNAL_LEAF_SPACES',
      message: 'The event must have at least one active internal leaf space.',
    };
  }

  const activeCheckpoints = checkpointsList.filter((c) => c.isActive);
  if (activeCheckpoints.length === 0) {
    return {
      code: 'NO_ACTIVE_CHECKPOINTS',
      message: 'The event must have at least one active checkpoint.',
    };
  }

  // Only active spaces count as valid checkpoint endpoints here: an active
  // checkpoint whose endpoint was deactivated after creation must fail
  // preflight/start, not silently pass because the space still exists.
  // This reuses validateCheckpointRules' own SPACE_A_NOT_FOUND/
  // SPACE_B_NOT_FOUND checks rather than duplicating the rule.
  const activeSpacesMap = new Map(spacesList.filter((s) => s.isActive).map((s) => [s.id, s]));
  for (const cp of activeCheckpoints) {
    const cpError = validateCheckpointRules(cp, activeSpacesMap);
    if (cpError) {
      return { code: `INVALID_CHECKPOINT_${cpError.code}`, message: `Checkpoint "${cp.name}": ${cpError.message}` };
    }
  }

  return null;
}

export async function getCompactEventState(db: AppDb, eventId: string): Promise<CompactEventState | null> {
  const eventRecord = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!eventRecord) return null;

  const allSpaces = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();
  const spaceStates = await db.select().from(spaceState).where(eq(spaceState.eventId, eventId)).all();

  const leafMap = new Map<string, number>();
  let totalLeafOccupancy = 0;

  for (const state of spaceStates) {
    leafMap.set(state.spaceId, state.occupancy);
  }

  const aggMap = calculateAggregateOccupancy(
    allSpaces.map((s) => ({ id: s.id, parentId: s.parentId, kind: s.kind })),
    leafMap
  );

  const spacesPayload = allSpaces.map((s) => {
    let occ = 0;
    if (s.kind === 'leaf') {
      occ = leafMap.get(s.id) || 0;
      totalLeafOccupancy += occ;
    } else if (s.kind === 'aggregate') {
      occ = aggMap.get(s.id) || 0;
    }
    return {
      id: s.id,
      name: s.name,
      kind: s.kind as any,
      occupancy: occ,
      capacity: s.capacity,
    };
  });

  return {
    version: eventRecord.version,
    eventStatus: eventRecord.status as any,
    eventOccupancy: totalLeafOccupancy,
    eventCapacity: eventRecord.capacity,
    spaces: spacesPayload,
    serverTimeMs: Date.now(),
    // Carried in every frame so a device that was away through the
    // transition still learns which epoch it has to acknowledge.
    closingStartedAtMs: eventRecord.closingStartedAtMs ?? null,
  };
}
