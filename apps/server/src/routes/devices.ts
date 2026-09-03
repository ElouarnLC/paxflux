import { FastifyInstance } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import type { ZodIssue } from 'zod';
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
  CreateDeviceInviteResponse,
  EventDeviceSummary,
  ErrorCode,
  DEVICE_OFFLINE_THRESHOLD_MS,
  DeviceHeartbeatResponse,
  RenameDeviceRequestSchema,
  RenameDeviceResponse,
} from '@paxflux/shared';
import {
  createDeviceInvite,
  exchangeDeviceInvite,
  resolvePairingBaseUrl,
  setDeviceSessionCookie,
  requireDeviceAuth,
  authenticateDeviceRequest,
  ExchangeDeviceInviteError,
} from '../auth/pairing.js';
import { requireStaffAuth } from '../auth/staff-sessions.js';
import { resolveDrainAcknowledgment } from '../domain/events.js';

export async function registerDeviceRoutes(app: FastifyInstance, sqlite: DatabaseSync, db: AppDb, env: Env) {
  // POST /api/v1/device/pair
  app.post('/api/v1/device/pair', async (req, reply) => {
    const parseResult = PairDeviceRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send(createProblemDetails(400, 'VALIDATION_ERROR', 'Token invalide', 'Le token d’appairage est requis.'));
    }

    const { token, appVersion } = parseResult.data;
    const result = exchangeDeviceInvite(sqlite, token, appVersion, env.DEVICE_SESSION_GRACE_HOURS);

    if ('error' in result) {
      const codeMap: Record<ExchangeDeviceInviteError, { status: number; code: ErrorCode; title: string; detail: string }> = {
        INVITE_NOT_FOUND: { status: 404, code: 'INVITE_NOT_FOUND', title: 'Invitation introuvable', detail: 'Ce QR code ou lien d’invitation n’existe pas.' },
        INVITE_EXPIRED: { status: 410, code: 'INVITE_EXPIRED', title: 'Invitation expirée', detail: 'Ce QR code a expiré.' },
        INVITE_ALREADY_USED: { status: 409, code: 'INVITE_ALREADY_USED', title: 'Invitation déjà utilisée', detail: 'Ce QR code à usage unique a déjà été utilisé.' },
        INVITE_REVOKED: { status: 403, code: 'INVITE_REVOKED', title: 'Invitation révoquée', detail: 'Cette invitation a été révoquée par un responsable.' },
        EVENT_NOT_PAIRABLE: {
          status: 409,
          code: 'EVENT_NOT_PAIRABLE',
          title: 'Événement non appairable',
          detail: 'Cet événement n’accepte plus de nouvel appareil (appairage possible en brouillon ou en direct uniquement).',
        },
        CHECKPOINT_UNUSABLE: {
          status: 409,
          code: 'CHECKPOINT_NOT_FOUND',
          title: 'Porte indisponible',
          detail: 'La porte associée à ce QR code n’est plus disponible pour cet événement. Demandez un nouveau QR code.',
        },
        INTERNAL_ERROR: { status: 500, code: 'INTERNAL_ERROR', title: 'Erreur interne', detail: 'L’appairage a échoué. Réessayez avec un nouveau QR code.' },
      };

      const info = codeMap[result.error];
      if (result.error === 'INTERNAL_ERROR') {
        // Never sent to the client: the response carries only the generic
        // detail above, with no SQL or driver text.
        app.log.error(
          { err: result.cause, rollbackErr: result.rollbackError },
          'Device pairing transaction failed unexpectedly'
        );
      }
      return reply.status(info.status).send(createProblemDetails(info.status, info.code, info.title, info.detail));
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
      closingStartedAtMs: eventRecord.closingStartedAtMs ?? null,
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

  // PATCH /api/v1/device/session
  //
  // A device renames itself, and nothing else.
  //
  // Singular and self by construction: there is no id in the path or the
  // body, so there is no id for a client to substitute. Identity comes from
  // the HttpOnly session cookie alone, which means the only session this can
  // ever reach is the one making the request — a device holding a valid
  // cookie cannot name another device by crafting a payload, because there
  // is nowhere in the contract to put one.
  //
  // `label` is the only writable field. Everything that decides what this
  // device *is* — its event, its checkpoint, its token, its expiry, its
  // pending count and sequence — is not in the request schema, so no extra
  // property in the body can reach a column.
  app.patch('/api/v1/device/session', async (req, reply) => {
    // Refuses a revoked, expired or unauthenticated device before anything
    // is read or written.
    const deviceSession = await requireDeviceAuth(req, reply, db, env);
    if (!deviceSession) return;

    const parseResult = RenameDeviceRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send(
          createProblemDetails(
            400,
            'VALIDATION_ERROR',
            'Nom d’appareil invalide',
            parseResult.error.errors[0]?.message ?? 'Le nom de l’appareil est invalide.',
            undefined,
            parseResult.error.errors.map((e: ZodIssue) => ({ name: 'label', reason: e.message }))
          )
        );
    }

    const label = parseResult.data.label;
    // Scoped to the authenticated session id, not to anything the caller
    // sent. A second guard behind the first: even a future refactor that
    // let an id into the body could not widen this WHERE clause.
    await db.update(deviceSessions).set({ label }).where(eq(deviceSessions.id, deviceSession.id));

    const response: RenameDeviceResponse = { deviceSession: { id: deviceSession.id, label } };
    return reply.status(200).send(response);
  });

  // POST /api/v1/device/heartbeat
  app.post('/api/v1/device/heartbeat', async (req, reply) => {
    const deviceSession = await requireDeviceAuth(req, reply, db, env);
    if (!deviceSession) return;

    const parseResult = DeviceHeartbeatRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      // A malformed heartbeat must never be coerced into a default
      // `{ pendingCount: 0 }`: that would tell the supervisor this device
      // has nothing left to synchronise while it may still be holding
      // queued actions — and would let a normal `/close` through on a lie.
      // Nothing is written at all, not even `lastSeenAtMs`: this request
      // proves nothing about the device's state.
      return reply.status(400).send(
        createProblemDetails(
          400,
          'VALIDATION_ERROR',
          'Heartbeat invalide',
          'Payload de heartbeat invalide.',
          undefined,
          parseResult.error.errors.map((e: ZodIssue) => ({
            name: e.path.join('.'),
            reason: e.message,
          }))
        )
      );
    }

    const body = parseResult.data;

    // Same rule as the batch endpoint, for the same reason: the cookie
    // authenticates a session, it does not prove the client is reporting
    // about that session. In the window a re-pairing opens — new cookie,
    // client configuration not yet replaced — an unasserted heartbeat
    // writes the previous device's pending count onto the new session, and
    // the supervisor is told the new device is holding counts it never
    // made. Refused before any mutation, `lastSeenAtMs` included.
    if (body.expectedDeviceSessionId !== deviceSession.id) {
      return reply
        .status(409)
        .send(
          createProblemDetails(
            409,
            'DEVICE_SESSION_MISMATCH',
            'Session appareil différente',
            'Ce heartbeat concerne un autre appairage de cet appareil.'
          )
        );
    }

    const now = Date.now();

    const eventRecord = await db
      .select()
      .from(events)
      .where(eq(events.id, deviceSession.eventId))
      .get();

    await db
      .update(deviceSessions)
      .set({
        lastSeenAtMs: now,
        lastPendingCount: body.pendingCount,
        lastClientSequence: body.lastClientSequence ?? deviceSession.lastClientSequence,
        appVersion: body.appVersion ?? deviceSession.appVersion,
        // Written with the count it is based on, never separately: a
        // confirmation that outlived its number would be worse than none.
        drainedForClosingAtMs: eventRecord
          ? resolveDrainAcknowledgment(eventRecord, body.observedClosingStartedAtMs, body.pendingCount)
          : null,
      })
      .where(eq(deviceSessions.id, deviceSession.id));

    // The canonical identity travels back on the beat that already proves
    // the session. That is what lets an open counter pick up a staff rename
    // without a second polling loop — and the id is what lets the client
    // refuse an answer describing a pairing it no longer holds.
    const response: DeviceHeartbeatResponse = {
      serverTimeMs: now,
      deviceSession: { id: deviceSession.id, label: deviceSession.label },
    };
    return reply.status(200).send(response);
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

    // The frontend picks a checkpoint from a dropdown, but that selection
    // is never the invariant: verify server-side that this checkpoint
    // really belongs to this event and is usable, so a crafted request can
    // never mint an invitation pointing at another event's door.
    const eventRecord = await db.select().from(events).where(eq(events.id, eventId)).get();
    if (!eventRecord) {
      return reply
        .status(404)
        .send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Événement introuvable.'));
    }

    // SPEC §5.1: devices are generated and paired in `draft`, and may still
    // be added in `live`. `closing` only drains already-paired devices;
    // `closed`/`archived` accept none.
    if (eventRecord.status !== 'draft' && eventRecord.status !== 'live') {
      return reply
        .status(409)
        .send(
          createProblemDetails(
            409,
            'EVENT_NOT_PAIRABLE',
            'Événement non appairable',
            'Un appareil ne peut être ajouté qu’en brouillon ou en direct.'
          )
        );
    }

    const checkpoint = await db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.eventId, eventId)))
      .get();
    if (!checkpoint) {
      return reply
        .status(404)
        .send(
          createProblemDetails(
            404,
            'CHECKPOINT_NOT_FOUND',
            'Checkpoint introuvable',
            'Ce checkpoint n’existe pas pour cet événement.'
          )
        );
    }
    if (!checkpoint.isActive) {
      return reply
        .status(409)
        .send(
          createProblemDetails(
            409,
            'VALIDATION_ERROR',
            'Checkpoint inactif',
            'Ce checkpoint est désactivé : aucun appareil ne peut y être appairé.'
          )
        );
    }

    // The server owns the pairing URL — see resolvePairingBaseUrl.
    const base = resolvePairingBaseUrl(env, { protocol: req.protocol, host: req.host });
    if ('error' in base) {
      return reply
        .status(409)
        .send(
          createProblemDetails(
            409,
            'VALIDATION_ERROR',
            'URL publique inconnue',
            'Impossible de déterminer l’URL d’appairage. Configurez PUBLIC_BASE_URL pour que le QR code soit utilisable.'
          )
        );
    }

    const invite = await createDeviceInvite(db, {
      eventId,
      checkpointId,
      createdBy: sessionData.user.id,
      expiresInMinutes,
      baseUrl: base.baseUrl,
    });

    const response: CreateDeviceInviteResponse = {
      ...invite,
      pairUrlSource: base.source,
      unreachableFromPhone: base.unreachableFromPhone,
      insecureForInstall: base.insecureForInstall,
    };

    return reply.status(201).send(response);
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
    const result: EventDeviceSummary[] = devicesList.map(({ device, checkpoint }) => ({
      id: device.id,
      checkpointId: device.checkpointId,
      checkpointName: checkpoint.name,
      label: device.label,
      isOnline: device.lastSeenAtMs !== null && now - device.lastSeenAtMs <= DEVICE_OFFLINE_THRESHOLD_MS,
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

    const parseResult = RenameDeviceRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send(
          createProblemDetails(
            400,
            'VALIDATION_ERROR',
            'Nom d’appareil invalide',
            parseResult.error.errors[0]?.message ?? 'Le nom de l’appareil est invalide.',
            undefined,
            parseResult.error.errors.map((e: ZodIssue) => ({ name: 'label', reason: e.message }))
          )
        );
    }

    // Read before writing so an unknown id is a 404 rather than a write that
    // matches nothing and reports success. The previous version answered
    // `{ success: true }` for any UUID at all, which told the management
    // table a rename had happened when nothing had.
    const existing = await db.select().from(deviceSessions).where(eq(deviceSessions.id, id)).get();
    if (!existing) {
      return reply
        .status(404)
        .send(createProblemDetails(404, 'DEVICE_NOT_FOUND', 'Appareil introuvable', 'Cette session appareil n’existe pas.'));
    }

    const label = parseResult.data.label;
    await db.update(deviceSessions).set({ label }).where(eq(deviceSessions.id, id));

    const response: RenameDeviceResponse = { deviceSession: { id, label } };
    return reply.status(200).send(response);
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
