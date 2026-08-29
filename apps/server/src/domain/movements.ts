import { DatabaseSync } from 'node:sqlite';
import { AppDb } from '../db/index.js';
import { events, spaces, spaceState, checkpoints, movements, auditLog } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { MovementSource, Direction } from '@paxflux/shared';

export interface ApplyCountActionParams {
  eventId: string;
  checkpointId: string;
  deviceSessionId?: string;
  actorUserId?: string;
  clientActionId: string;
  deviceSequence?: number;
  direction: Direction;
  clientTimeMs?: number;
  source?: MovementSource;
}

export interface ApplyReversalActionParams {
  eventId: string;
  checkpointId?: string;
  deviceSessionId?: string;
  actorUserId?: string;
  clientActionId: string;
  targetClientActionId: string;
  deviceSequence?: number;
  clientTimeMs?: number;
  source?: MovementSource;
}

export interface ApplyAdjustmentParams {
  eventId: string;
  spaceId: string;
  observedCount: number;
  reason: string;
  actorUserId: string;
}

export interface MovementResult {
  status: 'applied' | 'duplicate' | 'rejected';
  movementId?: number;
  eventVersion: number;
  errorCode?: string;
  isDuplicate?: boolean;
}

export async function executeMovementTransaction(
  sqlite: DatabaseSync,
  executeFn: () => Promise<MovementResult>
): Promise<MovementResult> {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const result = await executeFn();
    if (result.status === 'rejected') {
      sqlite.exec('ROLLBACK;');
      return result;
    }
    sqlite.exec('COMMIT;');
    return result;
  } catch (err) {
    sqlite.exec('ROLLBACK;');
    throw err;
  }
}

export async function applyCountAction(
  sqlite: DatabaseSync,
  db: AppDb,
  params: ApplyCountActionParams
): Promise<MovementResult> {
  return executeMovementTransaction(sqlite, async () => {
    const now = Date.now();

    // 1. Check idempotency:
    if (params.clientActionId) {
      const existing = await db
        .select()
        .from(movements)
        .where(eq(movements.clientActionId, params.clientActionId))
        .get();

      if (existing) {
        const ev = await db.select({ version: events.version }).from(events).where(eq(events.id, params.eventId)).get();
        return {
          status: 'applied',
          movementId: existing.id,
          eventVersion: ev?.version ?? existing.eventVersion,
          isDuplicate: true,
        };
      }
    }

    // 2. Load Event & Checkpoint
    const eventRecord = await db.select().from(events).where(eq(events.id, params.eventId)).get();
    if (!eventRecord) {
      return { status: 'rejected', errorCode: 'EVENT_NOT_FOUND', eventVersion: 0 };
    }
    if (eventRecord.status !== 'live' && eventRecord.status !== 'closing') {
      return { status: 'rejected', errorCode: 'EVENT_NOT_LIVE', eventVersion: eventRecord.version };
    }

    const cp = await db.select().from(checkpoints).where(eq(checkpoints.id, params.checkpointId)).get();
    if (!cp || !cp.isActive) {
      return { status: 'rejected', errorCode: 'CHECKPOINT_NOT_FOUND', eventVersion: eventRecord.version };
    }

    // 3. Map direction
    let fromSpaceId: string;
    let toSpaceId: string;

    if (params.direction === 'a_to_b') {
      if (!cp.allowAToB) {
        return { status: 'rejected', errorCode: 'DIRECTION_NOT_ALLOWED', eventVersion: eventRecord.version };
      }
      fromSpaceId = cp.spaceAId;
      toSpaceId = cp.spaceBId;
    } else {
      if (!cp.allowBToA) {
        return { status: 'rejected', errorCode: 'DIRECTION_NOT_ALLOWED', eventVersion: eventRecord.version };
      }
      fromSpaceId = cp.spaceBId;
      toSpaceId = cp.spaceAId;
    }

    // 4. Resolve space kinds
    const fromSpace = await db.select().from(spaces).where(eq(spaces.id, fromSpaceId)).get();
    const toSpace = await db.select().from(spaces).where(eq(spaces.id, toSpaceId)).get();

    if (!fromSpace || !toSpace) {
      return { status: 'rejected', errorCode: 'SPACE_NOT_FOUND', eventVersion: eventRecord.version };
    }

    // 5. Update space_state
    if (fromSpace.kind === 'leaf') {
      await adjustSpaceState(db, params.eventId, fromSpaceId, -1, now);
    }
    if (toSpace.kind === 'leaf') {
      await adjustSpaceState(db, params.eventId, toSpaceId, +1, now);
    }

    // 6. Increment event.version
    const newVersion = eventRecord.version + 1;
    await db.update(events).set({ version: newVersion, updatedAtMs: now }).where(eq(events.id, params.eventId));

    // 7. Insert movement ledger entry
    const inserted = await db
      .insert(movements)
      .values({
        eventId: params.eventId,
        checkpointId: params.checkpointId,
        deviceSessionId: params.deviceSessionId || null,
        actorUserId: params.actorUserId || null,
        kind: 'count',
        clientActionId: params.clientActionId,
        deviceSequence: params.deviceSequence ?? null,
        fromSpaceId,
        toSpaceId,
        quantity: 1,
        reversesMovementId: null,
        reason: null,
        clientTimeMs: params.clientTimeMs ?? null,
        serverTimeMs: now,
        eventVersion: newVersion,
        source: params.source || 'online',
      })
      .returning({ id: movements.id })
      .get();

    return {
      status: 'applied',
      movementId: inserted?.id,
      eventVersion: newVersion,
      isDuplicate: false,
    };
  });
}

export async function applyReversalAction(
  sqlite: DatabaseSync,
  db: AppDb,
  params: ApplyReversalActionParams
): Promise<MovementResult> {
  return executeMovementTransaction(sqlite, async () => {
    const now = Date.now();

    // 1. Check idempotency:
    if (params.clientActionId) {
      const existing = await db
        .select()
        .from(movements)
        .where(eq(movements.clientActionId, params.clientActionId))
        .get();

      if (existing) {
        const ev = await db.select({ version: events.version }).from(events).where(eq(events.id, params.eventId)).get();
        return {
          status: 'applied',
          movementId: existing.id,
          eventVersion: ev?.version ?? existing.eventVersion,
          isDuplicate: true,
        };
      }
    }

    // 2. Load Event
    const eventRecord = await db.select().from(events).where(eq(events.id, params.eventId)).get();
    if (!eventRecord) {
      return { status: 'rejected', errorCode: 'EVENT_NOT_FOUND', eventVersion: 0 };
    }
    if (eventRecord.status !== 'live' && eventRecord.status !== 'closing') {
      return { status: 'rejected', errorCode: 'EVENT_NOT_LIVE', eventVersion: eventRecord.version };
    }

    // 3. Find target movement to reverse
    const targetMovement = await db
      .select()
      .from(movements)
      .where(
        and(
          eq(movements.eventId, params.eventId),
          eq(movements.clientActionId, params.targetClientActionId)
        )
      )
      .get();

    if (!targetMovement) {
      return {
        status: 'rejected',
        errorCode: 'ORIGINAL_MOVEMENT_NOT_FOUND',
        eventVersion: eventRecord.version,
      };
    }

    // Check if target was already reversed
    const alreadyReversed = await db
      .select()
      .from(movements)
      .where(eq(movements.reversesMovementId, targetMovement.id))
      .get();

    if (alreadyReversed) {
      return {
        status: 'rejected',
        errorCode: 'ALREADY_REVERSED',
        eventVersion: eventRecord.version,
      };
    }

    // 4. Invert endpoints and apply compensating delta
    const revFromSpaceId = targetMovement.toSpaceId;
    const revToSpaceId = targetMovement.fromSpaceId;
    const quantity = targetMovement.quantity;

    if (revFromSpaceId) {
      const fromSpace = await db.select().from(spaces).where(eq(spaces.id, revFromSpaceId)).get();
      if (fromSpace && fromSpace.kind === 'leaf') {
        await adjustSpaceState(db, params.eventId, revFromSpaceId, -quantity, now);
      }
    }

    if (revToSpaceId) {
      const toSpace = await db.select().from(spaces).where(eq(spaces.id, revToSpaceId)).get();
      if (toSpace && toSpace.kind === 'leaf') {
        await adjustSpaceState(db, params.eventId, revToSpaceId, +quantity, now);
      }
    }

    // 5. Increment event.version
    const newVersion = eventRecord.version + 1;
    await db.update(events).set({ version: newVersion, updatedAtMs: now }).where(eq(events.id, params.eventId));

    // 6. Insert compensating reversal movement
    const inserted = await db
      .insert(movements)
      .values({
        eventId: params.eventId,
        checkpointId: targetMovement.checkpointId,
        deviceSessionId: params.deviceSessionId || targetMovement.deviceSessionId,
        actorUserId: params.actorUserId || null,
        kind: 'reversal',
        clientActionId: params.clientActionId,
        deviceSequence: params.deviceSequence ?? null,
        fromSpaceId: revFromSpaceId,
        toSpaceId: revToSpaceId,
        quantity,
        reversesMovementId: targetMovement.id,
        reason: `Reversal of action ${targetMovement.clientActionId || targetMovement.id}`,
        clientTimeMs: params.clientTimeMs ?? null,
        serverTimeMs: now,
        eventVersion: newVersion,
        source: params.source || 'online',
      })
      .returning({ id: movements.id })
      .get();

    return {
      status: 'applied',
      movementId: inserted?.id,
      eventVersion: newVersion,
      isDuplicate: false,
    };
  });
}

export async function applySupervisorAdjustment(
  sqlite: DatabaseSync,
  db: AppDb,
  params: ApplyAdjustmentParams
): Promise<MovementResult> {
  return executeMovementTransaction(sqlite, async () => {
    const now = Date.now();

    const eventRecord = await db.select().from(events).where(eq(events.id, params.eventId)).get();
    if (!eventRecord) {
      return { status: 'rejected', errorCode: 'EVENT_NOT_FOUND', eventVersion: 0 };
    }
    if (eventRecord.status !== 'live' && eventRecord.status !== 'closing') {
      return { status: 'rejected', errorCode: 'EVENT_NOT_LIVE', eventVersion: eventRecord.version };
    }

    const targetSpace = await db.select().from(spaces).where(eq(spaces.id, params.spaceId)).get();
    if (!targetSpace || targetSpace.kind !== 'leaf') {
      return { status: 'rejected', errorCode: 'INVALID_SPACE', eventVersion: eventRecord.version };
    }

    if (!params.reason || params.reason.trim().length < 3) {
      return { status: 'rejected', errorCode: 'REASON_REQUIRED', eventVersion: eventRecord.version };
    }

    // Get current occupancy
    const currentOccupancyRow = await db
      .select()
      .from(spaceState)
      .where(and(eq(spaceState.eventId, params.eventId), eq(spaceState.spaceId, params.spaceId)))
      .get();

    const currentOccupancy = currentOccupancyRow?.occupancy ?? 0;
    const delta = params.observedCount - currentOccupancy;

    if (delta === 0) {
      return {
        status: 'applied',
        eventVersion: eventRecord.version,
      };
    }

    let fromSpaceId: string | null = null;
    let toSpaceId: string | null = null;
    const quantity = Math.abs(delta);

    if (delta > 0) {
      // Net increase into the space from outside
      fromSpaceId = null;
      toSpaceId = params.spaceId;
      await adjustSpaceState(db, params.eventId, params.spaceId, +quantity, now);
    } else {
      // Net decrease out of the space
      fromSpaceId = params.spaceId;
      toSpaceId = null;
      await adjustSpaceState(db, params.eventId, params.spaceId, -quantity, now);
    }

    // Increment event.version
    const newVersion = eventRecord.version + 1;
    await db.update(events).set({ version: newVersion, updatedAtMs: now }).where(eq(events.id, params.eventId));

    // Insert adjustment movement
    const inserted = await db
      .insert(movements)
      .values({
        eventId: params.eventId,
        checkpointId: null,
        deviceSessionId: null,
        actorUserId: params.actorUserId,
        kind: 'adjustment',
        clientActionId: null,
        deviceSequence: null,
        fromSpaceId,
        toSpaceId,
        quantity,
        reversesMovementId: null,
        reason: params.reason.trim(),
        clientTimeMs: null,
        serverTimeMs: now,
        eventVersion: newVersion,
        source: 'staff',
      })
      .returning({ id: movements.id })
      .get();

    // Record in audit log
    await db.insert(auditLog).values({
      eventId: params.eventId,
      actorUserId: params.actorUserId,
      action: 'SUPERVISOR_ADJUSTMENT',
      entityType: 'space',
      entityId: params.spaceId,
      metadata: {
        previousOccupancy: currentOccupancy,
        observedCount: params.observedCount,
        delta,
        reason: params.reason.trim(),
        movementId: inserted?.id,
      },
      createdAtMs: now,
    });

    return {
      status: 'applied',
      movementId: inserted?.id,
      eventVersion: newVersion,
      isDuplicate: false,
    };
  });
}

async function adjustSpaceState(db: AppDb, eventId: string, spaceId: string, delta: number, now: number) {
  const existing = await db
    .select()
    .from(spaceState)
    .where(and(eq(spaceState.eventId, eventId), eq(spaceState.spaceId, spaceId)))
    .get();

  if (existing) {
    await db
      .update(spaceState)
      .set({
        occupancy: existing.occupancy + delta,
        updatedAtMs: now,
      })
      .where(and(eq(spaceState.eventId, eventId), eq(spaceState.spaceId, spaceId)));
  } else {
    await db.insert(spaceState).values({
      eventId,
      spaceId,
      occupancy: delta,
      updatedAtMs: now,
    });
  }
}
