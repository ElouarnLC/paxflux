import { FastifyInstance } from 'fastify';
import { AppDb } from '../db/index.js';
import { Env } from '../config/env.js';
import {
  deviceInvites,
  deviceSessions,
  events,
  checkpoints,
  spaces,
  spaceState,
} from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import {
  PairDeviceRequestSchema,
  CreateDeviceInviteRequestSchema,
  DeviceHeartbeatRequestSchema,
  createProblemDetails,
  DeviceBootstrapResponse,
  CompactEventState,
} from '@paxflux/shared';
import {
  createDeviceInvite,
  exchangeDeviceInvite,
  setDeviceSessionCookie,
  requireDeviceAuth,
  authenticateDeviceRequest,
} from '../auth/pairing.js';
import { requireStaffAuth } from '../auth/staff-sessions.js';

export async function registerDeviceRoutes(app: FastifyInstance, db: AppDb, env: Env) {
  // POST /api/v1/device/pair
  app.post('/api/v1/device/pair', async (req, reply) => {
    const parseResult = PairDeviceRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send(createProblemDetails(400, 'VALIDATION_ERROR', 'Token invalide', 'Le token d’appairage est requis.'));
    }

    const { token, appVersion } = parseResult.data;
    const result = await exchangeDeviceInvite(db, token, appVersion, env.DEVICE_SESSION_GRACE_HOURS);

    if ('error' in result) {
      const codeMap: Record<string, { status: number; title: string; detail: string }> = {
        INVITE_NOT_FOUND: { status: 404, title: 'Invitation introuvable', detail: 'Ce QR code ou lien d’invitation n’existe pas.' },
        INVITE_EXPIRED: { status: 410, title: 'Invitation expirée', detail: 'Ce QR code a expiré.' },
        INVITE_ALREADY_USED: { status: 409, title: 'Invitation déjà utilisée', detail: 'Ce QR code à usage unique a déjà été utilisé.' },
        INVITE_REVOKED: { status: 403, title: 'Invitation révoquée', detail: 'Cette invitation a été révoquée par un responsable.' },
      };

      const info = codeMap[result.error] || { status: 400, title: 'Erreur', detail: 'Invitation invalide' };
      return reply.status(info.status).send(createProblemDetails(info.status, result.error as any, info.title, info.detail));
    }

    setDeviceSessionCookie(reply, result.sessionToken, result.expiresAtMs, env);

    return reply.status(200).send({
      success: true,
      deviceSession: result.deviceSession,
    });
  });

  // GET /api/v1/device/bootstrap
  app.get('/api/v1/device/bootstrap', async (req, reply) => {
    const deviceSession = await authenticateDeviceRequest(req, db, env);
    if (!deviceSession) {
      return reply
        .status(401)
        .send(createProblemDetails(401, 'UNAUTHORIZED', 'Non appairé', 'Aucune session appareil active trouvée.'));
    }

    const eventRecord = await db.select().from(events).where(eq(events.id, deviceSession.eventId)).get();
    const cp = await db.select().from(checkpoints).where(eq(checkpoints.id, deviceSession.checkpointId)).get();

    if (!eventRecord || !cp) {
      return reply
        .status(404)
        .send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'L’événement ou la porte associée est introuvable.'));
    }

    const spaceA = await db.select().from(spaces).where(eq(spaces.id, cp.spaceAId)).get();
    const spaceB = await db.select().from(spaces).where(eq(spaces.id, cp.spaceBId)).get();

    // Get current space occupancies
    const spaceStates = await db.select().from(spaceState).where(eq(spaceState.eventId, eventRecord.id)).all();
    const allSpaces = await db.select().from(spaces).where(eq(spaces.eventId, eventRecord.id)).all();

    const stateMap = new Map(spaceStates.map((s) => [s.spaceId, s.occupancy]));
    let totalLeafOccupancy = 0;

    const spacesPayload = allSpaces.map((s) => {
      const occ = stateMap.get(s.id) || 0;
      if (s.kind === 'leaf') {
        totalLeafOccupancy += occ;
      }
      return {
        id: s.id,
        name: s.name,
        kind: s.kind as any,
        occupancy: occ,
        capacity: s.capacity,
      };
    });

    const compactState: CompactEventState = {
      version: eventRecord.version,
      eventStatus: eventRecord.status as any,
      eventOccupancy: totalLeafOccupancy,
      eventCapacity: eventRecord.capacity,
      spaces: spacesPayload,
      serverTimeMs: Date.now(),
    };

    const response: DeviceBootstrapResponse = {
      event: {
        id: eventRecord.id,
        name: eventRecord.name,
        status: eventRecord.status,
        capacity: eventRecord.capacity,
      },
      checkpoint: {
        id: cp.id,
        name: cp.name,
        spaceAId: cp.spaceAId,
        spaceBId: cp.spaceBId,
        spaceAName: spaceA?.name || 'Espace A',
        spaceBName: spaceB?.name || 'Espace B',
        labelAToB: cp.labelAToB,
        labelBToA: cp.labelBToA,
        allowAToB: cp.allowAToB,
        allowBToA: cp.allowBToA,
      },
      deviceSession: {
        id: deviceSession.id,
        label: deviceSession.label,
      },
      state: compactState,
    };

    return reply.status(200).send(response);
  });

  // POST /api/v1/device/heartbeat
  app.post('/api/v1/device/heartbeat', async (req, reply) => {
    const deviceSession = await requireDeviceAuth(req, reply, db, env);
    if (!deviceSession) return;

    const parseResult = DeviceHeartbeatRequestSchema.safeParse(req.body);
    const body = parseResult.success ? parseResult.data : { pendingCount: 0 };
    const now = Date.now();

    await db
      .update(deviceSessions)
      .set({
        lastSeenAtMs: now,
        lastPendingCount: body.pendingCount,
        lastClientSequence: body.lastClientSequence ?? deviceSession.lastClientSequence,
        appVersion: body.appVersion ?? deviceSession.appVersion,
      })
      .where(eq(deviceSessions.id, deviceSession.id));

    return reply.status(200).send({ serverTimeMs: now });
  });

  // POST /api/v1/events/:id/device-invites
  app.post('/api/v1/events/:id/device-invites', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
    const parseResult = CreateDeviceInviteRequestSchema.safeParse(req.body);

    if (!parseResult.success) {
      return reply
        .status(400)
        .send(createProblemDetails(400, 'VALIDATION_ERROR', 'Paramètres invalides', 'Checkpoint ID requis.'));
    }

    const { checkpointId, expiresInMinutes } = parseResult.data;

    const invite = await createDeviceInvite(db, {
      eventId,
      checkpointId,
      createdBy: sessionData.user.id,
      expiresInMinutes,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });

    return reply.status(201).send(invite);
  });

  // DELETE /api/v1/device-invites/:id
  app.delete('/api/v1/device-invites/:id', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const now = Date.now();

    await db.update(deviceInvites).set({ revokedAtMs: now }).where(eq(deviceInvites.id, id));
    return reply.status(200).send({ success: true });
  });

  // GET /api/v1/events/:id/devices
  app.get('/api/v1/events/:id/devices', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
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
    const result = devicesList.map(({ device, checkpoint }) => ({
      id: device.id,
      checkpointId: device.checkpointId,
      checkpointName: checkpoint.name,
      label: device.label,
      isOnline: device.lastSeenAtMs !== null && now - device.lastSeenAtMs <= 45_000,
      lastSeenAtMs: device.lastSeenAtMs,
      lastPendingCount: device.lastPendingCount,
      appVersion: device.appVersion,
    }));

    return reply.status(200).send(result);
  });

  // PATCH /api/v1/device-sessions/:id
  app.patch('/api/v1/device-sessions/:id', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const { label } = req.body as { label?: string };

    if (!label || label.trim().length === 0) {
      return reply
        .status(400)
        .send(createProblemDetails(400, 'VALIDATION_ERROR', 'Label requis', 'Le nom de l’appareil ne peut pas être vide.'));
    }

    await db.update(deviceSessions).set({ label: label.trim() }).where(eq(deviceSessions.id, id));
    return reply.status(200).send({ success: true, label: label.trim() });
  });

  // POST /api/v1/device-sessions/:id/revoke
  app.post('/api/v1/device-sessions/:id/revoke', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const now = Date.now();

    await db.update(deviceSessions).set({ revokedAtMs: now }).where(eq(deviceSessions.id, id));
    return reply.status(200).send({ success: true });
  });
}
