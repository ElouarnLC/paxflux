import { FastifyInstance } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { AppDb } from '../db/index.js';
import { Env } from '../config/env.js';
import {
  events,
  spaces,
  checkpoints,
  movements,
  deviceSessions,
} from '../db/schema.js';
import { eq, and, desc, count, isNull } from 'drizzle-orm';
import {
  BatchSyncRequestSchema,
  CreateAdjustmentRequestSchema,
  ActionAcknowledgment,
  BatchSyncResponse,
  createProblemDetails,
  SyncQuality,
} from '@paxflux/shared';
import { requireDeviceAuth } from '../auth/pairing.js';
import { requireStaffAuth } from '../auth/staff-sessions.js';
import {
  applyCountAction,
  applyReversalAction,
  applySupervisorAdjustment,
} from '../domain/movements.js';
import { getCompactEventState } from '../domain/events.js';
import { calculateAggregateOccupancy } from '../domain/spaces.js';
import { broadcaster } from '../realtime/broadcaster.js';

export async function registerCountingRoutes(
  app: FastifyInstance,
  sqlite: DatabaseSync,
  db: AppDb,
  env: Env
) {
  // POST /api/v1/device/actions/batch
  app.post('/api/v1/device/actions/batch', async (req, reply) => {
    const deviceSession = await requireDeviceAuth(req, reply, db, env);
    if (!deviceSession) return;

    const parseResult = BatchSyncRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send(
          createProblemDetails(
            400,
            'VALIDATION_ERROR',
            'Payload invalide',
            'Format de batch d’actions invalide.',
            undefined,
            parseResult.error.errors.map((e: any) => ({
              name: e.path.join('.'),
              reason: e.message,
            }))
          )
        );
    }

    const { actions, pendingCount = 0, appVersion } = parseResult.data;
    const now = Date.now();
    const eventId = deviceSession.eventId;
    const checkpointId = deviceSession.checkpointId;

    const acknowledgments: ActionAcknowledgment[] = [];
    const source = actions.length > 1 ? 'offline_batch' : 'online';

    for (const action of actions) {
      if (action.type === 'count') {
        const res = await applyCountAction(sqlite, db, {
          eventId,
          checkpointId,
          deviceSessionId: deviceSession.id,
          clientActionId: action.clientActionId,
          deviceSequence: action.sequence,
          direction: action.direction,
          clientTimeMs: action.clientCreatedAtMs,
          source,
        });

        acknowledgments.push({
          clientActionId: action.clientActionId,
          status: res.status,
          movementId: res.movementId,
          errorCode: res.errorCode,
        });
      } else if (action.type === 'reversal') {
        const res = await applyReversalAction(sqlite, db, {
          eventId,
          checkpointId,
          deviceSessionId: deviceSession.id,
          clientActionId: action.clientActionId,
          targetClientActionId: action.targetClientActionId,
          deviceSequence: action.sequence,
          clientTimeMs: action.clientCreatedAtMs,
          source,
        });

        acknowledgments.push({
          clientActionId: action.clientActionId,
          status: res.status,
          movementId: res.movementId,
          errorCode: res.errorCode,
        });
      }
    }

    // Update device session status
    await db
      .update(deviceSessions)
      .set({
        lastSeenAtMs: now,
        lastPendingCount: pendingCount,
        appVersion: appVersion || deviceSession.appVersion,
      })
      .where(eq(deviceSessions.id, deviceSession.id));

    // Get current compact state
    const compactState = await getCompactEventState(db, eventId);
    if (compactState) {
      broadcaster.broadcastState(eventId, compactState);
    }

    const response: BatchSyncResponse = {
      acknowledged: acknowledgments,
      state: compactState || {
        version: 0,
        eventStatus: 'live',
        eventOccupancy: 0,
        eventCapacity: 0,
        spaces: [],
        serverTimeMs: now,
      },
    };

    return reply.status(200).send(response);
  });

  // POST /api/v1/events/:id/adjustments
  app.post('/api/v1/events/:id/adjustments', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
    const parseResult = CreateAdjustmentRequestSchema.safeParse(req.body);

    if (!parseResult.success) {
      return reply
        .status(400)
        .send(
          createProblemDetails(
            400,
            'VALIDATION_ERROR',
            'Paramètres invalides',
            'Motif et comptage observé requis.',
            undefined,
            parseResult.error.errors.map((e: any) => ({
              name: e.path.join('.'),
              reason: e.message,
            }))
          )
        );
    }

    const { spaceId, observedCount, reason } = parseResult.data;

    const res = await applySupervisorAdjustment(sqlite, db, {
      eventId,
      spaceId,
      observedCount,
      reason,
      actorUserId: sessionData.user.id,
    });

    if (res.status === 'rejected') {
      return reply
        .status(400)
        .send(createProblemDetails(400, (res.errorCode as any) || 'VALIDATION_ERROR', 'Ajustement refusé', 'Impossible d’appliquer cet ajustement.'));
    }

    const compactState = await getCompactEventState(db, eventId);
    if (compactState) {
      broadcaster.broadcastState(eventId, compactState);
    }

    return reply.status(200).send({
      success: true,
      movementId: res.movementId,
      state: compactState,
    });
  });

  // GET /api/v1/events/:id/movements
  app.get('/api/v1/events/:id/movements', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
    const query = req.query as { limit?: string; offset?: string; checkpointId?: string };
    const limit = Math.min(Math.max(parseInt(query.limit || '50', 10), 1), 500);
    const offset = Math.max(parseInt(query.offset || '0', 10), 0);

    const movementsList = await db
      .select({
        id: movements.id,
        kind: movements.kind,
        checkpointId: movements.checkpointId,
        quantity: movements.quantity,
        fromSpaceId: movements.fromSpaceId,
        toSpaceId: movements.toSpaceId,
        reason: movements.reason,
        serverTimeMs: movements.serverTimeMs,
        source: movements.source,
        deviceSessionId: movements.deviceSessionId,
        actorUserId: movements.actorUserId,
      })
      .from(movements)
      .where(eq(movements.eventId, eventId))
      .orderBy(desc(movements.id))
      .limit(limit)
      .offset(offset)
      .all();

    const totalCount = await db
      .select({ count: count() })
      .from(movements)
      .where(eq(movements.eventId, eventId))
      .get();

    return reply.status(200).send({
      movements: movementsList,
      total: totalCount?.count || 0,
      limit,
      offset,
    });
  });

  // GET /api/v1/events/:id/state
  app.get('/api/v1/events/:id/state', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, eventId)).get();

    if (!eventRecord) {
      return reply
        .status(404)
        .send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Cet événement n’existe pas.'));
    }

    const allSpaces = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();
    const allCheckpoints = await db.select().from(checkpoints).where(eq(checkpoints.eventId, eventId)).all();
    const compactState = await getCompactEventState(db, eventId);

    const devicesList = await db
      .select({
        device: deviceSessions,
        checkpoint: checkpoints,
      })
      .from(deviceSessions)
      .innerJoin(checkpoints, eq(deviceSessions.checkpointId, checkpoints.id))
      .where(and(eq(deviceSessions.eventId, eventId), isNull(deviceSessions.revokedAtMs)))
      .all();

    const now = Date.now();
    let offlineCount = 0;
    let totalPending = 0;

    const devicesPayload = devicesList.map(({ device, checkpoint }) => {
      const isOnline = device.lastSeenAtMs !== null && now - device.lastSeenAtMs <= 45_000;
      if (!isOnline) offlineCount++;
      totalPending += device.lastPendingCount;

      return {
        id: device.id,
        checkpointId: device.checkpointId,
        checkpointName: checkpoint.name,
        label: device.label,
        isOnline,
        lastSeenAtMs: device.lastSeenAtMs,
        lastPendingCount: device.lastPendingCount,
        appVersion: device.appVersion,
      };
    });

    let syncQuality: SyncQuality = 'reliable';
    if (offlineCount > 1 || (devicesPayload.length > 0 && offlineCount === devicesPayload.length)) {
      syncQuality = 'uncertain';
    } else if (offlineCount > 0 || totalPending > 0) {
      syncQuality = 'degraded';
    }

    const spaceOccupancies: Record<string, number> = {};
    if (compactState) {
      for (const s of compactState.spaces) {
        spaceOccupancies[s.id] = s.occupancy;
      }
    }

    return reply.status(200).send({
      event: eventRecord,
      spaces: allSpaces,
      checkpoints: allCheckpoints,
      occupancy: {
        global: compactState?.eventOccupancy || 0,
        spaces: spaceOccupancies,
      },
      devices: devicesPayload,
      syncQuality,
    });
  });
}
