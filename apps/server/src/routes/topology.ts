import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { AppDb } from '../db/index.js';
import { Env } from '../config/env.js';
import { events, spaces, checkpoints, spaceState } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import {
  CreateSpaceRequestSchema,
  UpdateSpaceRequestSchema,
  CreateCheckpointRequestSchema,
  UpdateCheckpointRequestSchema,
  createProblemDetails,
} from '@paxflux/shared';
import { requireStaffAuth } from '../auth/staff-sessions.js';
import { validateSpaceRules } from '../domain/spaces.js';
import { validateCheckpointRules } from '../domain/checkpoints.js';

export async function registerTopologyRoutes(app: FastifyInstance, db: AppDb, env: Env) {
  // GET /api/v1/events/:id/spaces
  app.get('/api/v1/events/:id/spaces', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
    const spacesList = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();
    return reply.status(200).send(spacesList);
  });

  // POST /api/v1/events/:id/spaces
  app.post('/api/v1/events/:id/spaces', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, eventId)).get();

    if (!eventRecord) {
      return reply.status(404).send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Événement introuvable.'));
    }
    if (eventRecord.status !== 'draft') {
      return reply.status(409).send(createProblemDetails(409, 'TOPOLOGY_LOCKED', 'Topologie verrouillée', 'La topologie ne peut être modifiée qu’en mode brouillon.'));
    }

    const parseResult = CreateSpaceRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send(createProblemDetails(400, 'VALIDATION_ERROR', 'Paramètres invalides', 'Données d’espace invalides.'));
    }

    const { name, kind, parentId, capacity, sortOrder } = parseResult.data;
    const existingSpaces = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();

    const ruleError = validateSpaceRules({ kind, parentId, capacity }, existingSpaces);
    if (ruleError) {
      return reply.status(400).send(createProblemDetails(400, (ruleError.code as any) || 'VALIDATION_ERROR', 'Règle topologique enfreinte', ruleError.message));
    }

    const spaceId = crypto.randomUUID();
    const now = Date.now();

    await db.insert(spaces).values({
      id: spaceId,
      eventId,
      parentId: parentId || null,
      name: name.trim(),
      kind,
      capacity: capacity ?? null,
      sortOrder: sortOrder ?? 0,
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // Initialize space_state if leaf
    if (kind === 'leaf') {
      await db.insert(spaceState).values({
        eventId,
        spaceId,
        occupancy: 0,
        updatedAtMs: now,
      });
    }

    const created = await db.select().from(spaces).where(eq(spaces.id, spaceId)).get();
    return reply.status(201).send(created);
  });

  // GET /api/v1/events/:id/checkpoints
  app.get('/api/v1/events/:id/checkpoints', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
    const checkpointsList = await db.select().from(checkpoints).where(eq(checkpoints.eventId, eventId)).all();
    return reply.status(200).send(checkpointsList);
  });

  // POST /api/v1/events/:id/checkpoints
  app.post('/api/v1/events/:id/checkpoints', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, eventId)).get();

    if (!eventRecord) {
      return reply.status(404).send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Événement introuvable.'));
    }
    if (eventRecord.status !== 'draft') {
      return reply.status(409).send(createProblemDetails(409, 'TOPOLOGY_LOCKED', 'Topologie verrouillée', 'La topologie ne peut être modifiée qu’en mode brouillon.'));
    }

    const parseResult = CreateCheckpointRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send(createProblemDetails(400, 'VALIDATION_ERROR', 'Paramètres invalides', 'Données de checkpoint invalides.'));
    }

    const { name, spaceAId, spaceBId, allowAToB, allowBToA, labelAToB, labelBToA, sortOrder } = parseResult.data;
    const existingSpaces = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();
    const spacesMap = new Map(existingSpaces.map((s) => [s.id, s as any]));

    const cpError = validateCheckpointRules({ spaceAId, spaceBId, allowAToB, allowBToA }, spacesMap);
    if (cpError) {
      return reply.status(400).send(createProblemDetails(400, (cpError.code as any) || 'VALIDATION_ERROR', 'Checkpoint invalide', cpError.message));
    }

    const cpId = crypto.randomUUID();
    const now = Date.now();

    await db.insert(checkpoints).values({
      id: cpId,
      eventId,
      name: name.trim(),
      spaceAId,
      spaceBId,
      allowAToB: allowAToB ?? true,
      allowBToA: allowBToA ?? true,
      labelAToB: labelAToB.trim(),
      labelBToA: labelBToA.trim(),
      sortOrder: sortOrder ?? 0,
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });

    const created = await db.select().from(checkpoints).where(eq(checkpoints.id, cpId)).get();
    return reply.status(201).send(created);
  });
}
