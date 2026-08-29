import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { AppDb } from '../db/index.js';
import { Env } from '../config/env.js';
import { events, spaces, spaceState, checkpoints, auditLog } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import {
  CreateEventRequestSchema,
  UpdateEventRequestSchema,
  createProblemDetails,
} from '@paxflux/shared';
import { requireStaffAuth } from '../auth/staff-sessions.js';
import { isValidStatusTransition, validateEventForLive } from '../domain/events.js';
import { broadcaster } from '../realtime/broadcaster.js';

export async function registerEventRoutes(app: FastifyInstance, db: AppDb, env: Env) {
  // GET /api/v1/events
  app.get('/api/v1/events', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const eventsList = await db
      .select()
      .from(events)
      .orderBy(desc(events.createdAtMs))
      .all();

    return reply.status(200).send(eventsList);
  });

  // POST /api/v1/events
  app.post('/api/v1/events', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const parseResult = CreateEventRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send(
          createProblemDetails(
            400,
            'VALIDATION_ERROR',
            'Paramètres invalides',
            'Données d’événement invalides.',
            undefined,
            parseResult.error.errors.map((e: any) => ({
              name: e.path.join('.'),
              reason: e.message,
            }))
          )
        );
    }

    const { name, timezone, capacity, warningRatio1, warningRatio2, startsAtMs, endsAtMs } = parseResult.data;
    const eventId = crypto.randomUUID();
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${Date.now().toString(36)}`;
    const now = Date.now();

    await db.insert(events).values({
      id: eventId,
      name: name.trim(),
      slug,
      timezone,
      capacity,
      status: 'draft',
      warningRatio1,
      warningRatio2,
      startsAtMs: startsAtMs ?? null,
      endsAtMs: endsAtMs ?? null,
      version: 1,
      createdBy: sessionData.user.id,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // Default Seed: Extérieur (external) and Site (leaf)
    const extId = crypto.randomUUID();
    const siteId = crypto.randomUUID();

    await db.insert(spaces).values([
      {
        id: extId,
        eventId,
        parentId: null,
        name: 'Extérieur',
        kind: 'external',
        sortOrder: 0,
        isActive: true,
        createdAtMs: now,
        updatedAtMs: now,
      },
      {
        id: siteId,
        eventId,
        parentId: null,
        name: 'Site',
        kind: 'leaf',
        capacity,
        sortOrder: 1,
        isActive: true,
        createdAtMs: now,
        updatedAtMs: now,
      },
    ]);

    await db.insert(spaceState).values({
      eventId,
      spaceId: siteId,
      occupancy: 0,
      updatedAtMs: now,
    });

    const created = await db.select().from(events).where(eq(events.id, eventId)).get();
    return reply.status(201).send(created);
  });

  // GET /api/v1/events/:id
  app.get('/api/v1/events/:id', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, id)).get();

    if (!eventRecord) {
      return reply
        .status(404)
        .send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Événement introuvable.'));
    }

    return reply.status(200).send(eventRecord);
  });

  // PATCH /api/v1/events/:id
  app.patch('/api/v1/events/:id', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, id)).get();

    if (!eventRecord) {
      return reply
        .status(404)
        .send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Événement introuvable.'));
    }

    const parseResult = UpdateEventRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send(createProblemDetails(400, 'VALIDATION_ERROR', 'Paramètres invalides', 'Données de mise à jour invalides.'));
    }

    const updates = parseResult.data;
    const now = Date.now();

    // If live, capacity updates must be audited
    if (eventRecord.status === 'live' && updates.capacity !== undefined && updates.capacity !== eventRecord.capacity) {
      await db.insert(auditLog).values({
        eventId: id,
        actorUserId: sessionData.user.id,
        action: 'CAPACITY_UPDATE',
        entityType: 'event',
        entityId: id,
        metadata: {
          oldCapacity: eventRecord.capacity,
          newCapacity: updates.capacity,
        },
        createdAtMs: now,
      });
    }

    await db
      .update(events)
      .set({
        ...updates,
        updatedAtMs: now,
      })
      .where(eq(events.id, id));

    const updated = await db.select().from(events).where(eq(events.id, id)).get();
    return reply.status(200).send(updated);
  });

  // POST /api/v1/events/:id/start
  app.post('/api/v1/events/:id/start', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, id)).get();

    if (!eventRecord) {
      return reply.status(404).send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Événement introuvable.'));
    }
    if (eventRecord.status !== 'draft') {
      return reply.status(409).send(createProblemDetails(409, 'INVALID_LIFECYCLE_TRANSITION', 'Transition invalide', 'Seul un événement en brouillon peut être démarré.'));
    }

    const allSpaces = await db.select().from(spaces).where(eq(spaces.eventId, id)).all();
    const allCheckpoints = await db.select().from(checkpoints).where(eq(checkpoints.eventId, id)).all();

    const validationError = validateEventForLive(
      { capacity: eventRecord.capacity },
      allSpaces as any,
      allCheckpoints as any
    );

    if (validationError) {
      return reply.status(400).send(createProblemDetails(400, validationError.code as any, 'Topologie invalide pour le live', validationError.message));
    }

    const now = Date.now();
    await db
      .update(events)
      .set({
        status: 'live',
        liveStartedAtMs: now,
        topologyLockedAtMs: now,
        updatedAtMs: now,
      })
      .where(eq(events.id, id));

    broadcaster.broadcastMessage(id, {
      type: 'event-status',
      data: {
        eventId: id,
        status: 'live',
        version: eventRecord.version,
        timestampMs: now,
      },
    });

    const updated = await db.select().from(events).where(eq(events.id, id)).get();
    return reply.status(200).send(updated);
  });

  // POST /api/v1/events/:id/begin-closing
  app.post('/api/v1/events/:id/begin-closing', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, id)).get();

    if (!eventRecord || eventRecord.status !== 'live') {
      return reply.status(409).send(createProblemDetails(409, 'INVALID_LIFECYCLE_TRANSITION', 'Transition invalide', 'L’événement doit être en direct pour initier la fermeture.'));
    }

    const now = Date.now();
    await db
      .update(events)
      .set({
        status: 'closing',
        closingStartedAtMs: now,
        updatedAtMs: now,
      })
      .where(eq(events.id, id));

    broadcaster.broadcastMessage(id, {
      type: 'event-status',
      data: {
        eventId: id,
        status: 'closing',
        version: eventRecord.version,
        timestampMs: now,
      },
    });

    const updated = await db.select().from(events).where(eq(events.id, id)).get();
    return reply.status(200).send(updated);
  });

  // POST /api/v1/events/:id/close
  app.post('/api/v1/events/:id/close', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, id)).get();

    if (!eventRecord || (eventRecord.status !== 'live' && eventRecord.status !== 'closing')) {
      return reply.status(409).send(createProblemDetails(409, 'INVALID_LIFECYCLE_TRANSITION', 'Transition invalide', 'L’événement n’est pas en état de clôture.'));
    }

    const now = Date.now();
    await db
      .update(events)
      .set({
        status: 'closed',
        closedAtMs: now,
        updatedAtMs: now,
      })
      .where(eq(events.id, id));

    broadcaster.broadcastMessage(id, {
      type: 'event-status',
      data: {
        eventId: id,
        status: 'closed',
        version: eventRecord.version,
        timestampMs: now,
      },
    });

    const updated = await db.select().from(events).where(eq(events.id, id)).get();
    return reply.status(200).send(updated);
  });

  // POST /api/v1/events/:id/reopen
  app.post('/api/v1/events/:id/reopen', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason?: string };

    if (!reason || reason.trim().length < 3) {
      return reply.status(400).send(createProblemDetails(400, 'VALIDATION_ERROR', 'Motif requis', 'Un motif explicite est requis pour réouvrir un événement clos.'));
    }

    const eventRecord = await db.select().from(events).where(eq(events.id, id)).get();
    if (!eventRecord || eventRecord.status !== 'closed') {
      return reply.status(409).send(createProblemDetails(409, 'INVALID_LIFECYCLE_TRANSITION', 'Transition invalide', 'Seul un événement clos peut être réouvert.'));
    }

    const now = Date.now();
    await db
      .update(events)
      .set({
        status: 'live',
        closedAtMs: null,
        updatedAtMs: now,
      })
      .where(eq(events.id, id));

    await db.insert(auditLog).values({
      eventId: id,
      actorUserId: sessionData.user.id,
      action: 'EVENT_REOPEN',
      entityType: 'event',
      entityId: id,
      metadata: { reason: reason.trim() },
      createdAtMs: now,
    });

    broadcaster.broadcastMessage(id, {
      type: 'event-status',
      data: {
        eventId: id,
        status: 'live',
        version: eventRecord.version,
        timestampMs: now,
      },
    });

    const updated = await db.select().from(events).where(eq(events.id, id)).get();
    return reply.status(200).send(updated);
  });

  // POST /api/v1/events/:id/archive
  app.post('/api/v1/events/:id/archive', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, id)).get();

    if (!eventRecord || eventRecord.status !== 'closed') {
      return reply.status(409).send(createProblemDetails(409, 'INVALID_LIFECYCLE_TRANSITION', 'Transition invalide', 'Seul un événement clos peut être archivé.'));
    }

    const now = Date.now();
    await db
      .update(events)
      .set({
        status: 'archived',
        archivedAtMs: now,
        updatedAtMs: now,
      })
      .where(eq(events.id, id));

    broadcaster.closeAllForEvent(id);

    const updated = await db.select().from(events).where(eq(events.id, id)).get();
    return reply.status(200).send(updated);
  });
}
