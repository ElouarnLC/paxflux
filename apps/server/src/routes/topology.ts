import { FastifyInstance, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ZodIssue } from 'zod';
import { AppDb } from '../db/index.js';
import { Env } from '../config/env.js';
import { events, spaces, checkpoints, spaceState, deviceSessions, movements } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import {
  CreateSpaceRequestSchema,
  UpdateSpaceRequestSchema,
  CreateCheckpointRequestSchema,
  UpdateCheckpointRequestSchema,
  CreateEventDraftRequestSchema,
  createProblemDetails,
} from '@paxflux/shared';
import { requireStaffAuth } from '../auth/staff-sessions.js';
import { validateSpaceRules } from '../domain/spaces.js';
import { validateCheckpointRules } from '../domain/checkpoints.js';
import { createEventDraftAtomic } from '../domain/topology.js';

export async function registerTopologyRoutes(app: FastifyInstance, sqlite: DatabaseSync, db: AppDb, env: Env) {
  // POST /api/v1/events/drafts — Phase 4: create a draft event and its full
  // topology (spaces + checkpoints) in one SQLite transaction. See
  // domain/topology.ts for the atomicity guarantee. This is the only entry
  // point the wizard uses; POST /events, /spaces and /checkpoints remain
  // available individually for other flows (they already reuse the same
  // validators and draft-only gating).
  app.post('/api/v1/events/drafts', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const parseResult = CreateEventDraftRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send(
          createProblemDetails(
            400,
            'VALIDATION_ERROR',
            'Paramètres invalides',
            'Payload de topologie invalide.',
            undefined,
            parseResult.error.errors.map((e: ZodIssue) => ({
              name: e.path.join('.'),
              reason: e.message,
            }))
          )
        );
    }

    const result = await createEventDraftAtomic(sqlite, parseResult.data, sessionData.user.id);
    if (!result.ok) {
      if (result.status === 500) {
        app.log.error(
          { err: result.cause, rollbackErr: result.rollbackError },
          'Atomic event-draft creation failed unexpectedly'
        );
      }
      return reply
        .status(result.status)
        .send(createProblemDetails(result.status, result.code, 'Création de topologie refusée', result.detail));
    }

    return reply.status(201).send(result);
  });

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
    const spacesMap = new Map(existingSpaces.map((s) => [s.id, s]));

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

  // Shared guard for the draft-only editing routes below: 404 if the event
  // doesn't exist, 409 TOPOLOGY_LOCKED once it has left `draft` — the same
  // rule already enforced by POST /spaces and POST /checkpoints above.
  async function requireDraftEvent(reply: FastifyReply, eventId: string) {
    const eventRecord = await db.select().from(events).where(eq(events.id, eventId)).get();
    if (!eventRecord) {
      reply.status(404).send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Événement introuvable.'));
      return null;
    }
    if (eventRecord.status !== 'draft') {
      reply
        .status(409)
        .send(createProblemDetails(409, 'TOPOLOGY_LOCKED', 'Topologie verrouillée', 'La topologie ne peut être modifiée qu’en mode brouillon.'));
      return null;
    }
    return eventRecord;
  }

  /**
   * The device sessions still bound to a checkpoint.
   *
   * A paired counter holds this checkpoint's endpoints in its own storage —
   * `/device/bootstrap` hands them over and the browser caches them — and it
   * projects every tap across that cached pair before the server ever sees
   * it. The server, meanwhile, maps a tap through the checkpoint's *current*
   * endpoints (`domain/movements.ts`). Change the endpoints under a live
   * pairing and the two stop describing the same movement: the device counts
   * one crossing while the ledger records another. Deleting the checkpoint
   * is worse still — `device_sessions.checkpoint_id` is a non-null foreign
   * key pointing at it.
   *
   * So a structural edit is refused while a session is live, and the
   * operator revokes and re-pairs instead. Nothing is migrated: a device is
   * never silently rewritten onto different semantics.
   */
  async function activeDeviceSessionsFor(checkpointId: string) {
    return db
      .select()
      .from(deviceSessions)
      .where(and(eq(deviceSessions.checkpointId, checkpointId), isNull(deviceSessions.revokedAtMs)))
      .all();
  }

  function refuseStructuralEdit(reply: FastifyReply, count: number, action: string) {
    return reply
      .status(409)
      .send(
        createProblemDetails(
          409,
          'CHECKPOINT_IN_USE',
          'Porte utilisée par un appareil',
          `${count} appareil${count > 1 ? 's sont appairés' : ' est appairé'} à cette porte. ` +
            `Révoquez-${count > 1 ? 'les' : 'le'} depuis la gestion des appareils avant de ${action}, ` +
            'puis appairez à nouveau : un appareil déjà appairé garde en mémoire les zones de cette porte.'
        )
      );
  }

  // PATCH /api/v1/events/:id/spaces/:spaceId
  app.patch('/api/v1/events/:id/spaces/:spaceId', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id: eventId, spaceId } = req.params as { id: string; spaceId: string };
    if (!(await requireDraftEvent(reply, eventId))) return;

    const existingSpace = await db.select().from(spaces).where(and(eq(spaces.id, spaceId), eq(spaces.eventId, eventId))).get();
    if (!existingSpace) {
      return reply.status(404).send(createProblemDetails(404, 'SPACE_NOT_FOUND', 'Espace introuvable', 'Espace introuvable.'));
    }

    const parseResult = UpdateSpaceRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send(createProblemDetails(400, 'VALIDATION_ERROR', 'Paramètres invalides', 'Données d’espace invalides.'));
    }

    const patch = parseResult.data;
    const otherSpaces = await db.select().from(spaces).where(and(eq(spaces.eventId, eventId), eq(spaces.isActive, true))).all();

    const parentId = patch.parentId !== undefined ? patch.parentId : existingSpace.parentId;
    const capacity = patch.capacity !== undefined ? patch.capacity : existingSpace.capacity;
    const ruleError = validateSpaceRules({ kind: existingSpace.kind, parentId, capacity }, otherSpaces, spaceId);
    if (ruleError) {
      return reply.status(400).send(createProblemDetails(400, 'VALIDATION_ERROR', 'Règle topologique enfreinte', ruleError.message));
    }

    await db
      .update(spaces)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
        ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        updatedAtMs: Date.now(),
      })
      .where(eq(spaces.id, spaceId));

    const updated = await db.select().from(spaces).where(eq(spaces.id, spaceId)).get();
    return reply.status(200).send(updated);
  });

  // DELETE /api/v1/events/:id/spaces/:spaceId
  app.delete('/api/v1/events/:id/spaces/:spaceId', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id: eventId, spaceId } = req.params as { id: string; spaceId: string };
    if (!(await requireDraftEvent(reply, eventId))) return;

    const existingSpace = await db.select().from(spaces).where(and(eq(spaces.id, spaceId), eq(spaces.eventId, eventId))).get();
    if (!existingSpace) {
      return reply.status(404).send(createProblemDetails(404, 'SPACE_NOT_FOUND', 'Espace introuvable', 'Espace introuvable.'));
    }

    const referencingCheckpoint = await db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.eventId, eventId), eq(checkpoints.spaceAId, spaceId)))
      .get();
    const referencingCheckpointB = await db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.eventId, eventId), eq(checkpoints.spaceBId, spaceId)))
      .get();
    const childSpace = await db.select().from(spaces).where(and(eq(spaces.eventId, eventId), eq(spaces.parentId, spaceId))).get();

    if (referencingCheckpoint || referencingCheckpointB || childSpace) {
      return reply
        .status(409)
        .send(
          createProblemDetails(
            409,
            'SPACE_IN_USE',
            'Espace utilisé',
            'Cet espace est référencé par un checkpoint ou un espace enfant ; supprimez-les d’abord.'
          )
        );
    }

    await db.delete(spaceState).where(and(eq(spaceState.eventId, eventId), eq(spaceState.spaceId, spaceId)));
    await db.delete(spaces).where(eq(spaces.id, spaceId));

    return reply.status(200).send({ success: true });
  });

  // PATCH /api/v1/events/:id/checkpoints/:checkpointId
  app.patch('/api/v1/events/:id/checkpoints/:checkpointId', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id: eventId, checkpointId } = req.params as { id: string; checkpointId: string };
    if (!(await requireDraftEvent(reply, eventId))) return;

    const existingCheckpoint = await db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.eventId, eventId)))
      .get();
    if (!existingCheckpoint) {
      return reply.status(404).send(createProblemDetails(404, 'CHECKPOINT_NOT_FOUND', 'Checkpoint introuvable', 'Checkpoint introuvable.'));
    }

    const parseResult = UpdateCheckpointRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send(createProblemDetails(400, 'VALIDATION_ERROR', 'Paramètres invalides', 'Données de checkpoint invalides.'));
    }

    const patch = parseResult.data;
    const allowAToB = patch.allowAToB !== undefined ? patch.allowAToB : existingCheckpoint.allowAToB;
    const allowBToA = patch.allowBToA !== undefined ? patch.allowBToA : existingCheckpoint.allowBToA;
    const spaceAId = patch.spaceAId !== undefined ? patch.spaceAId : existingCheckpoint.spaceAId;
    const spaceBId = patch.spaceBId !== undefined ? patch.spaceBId : existingCheckpoint.spaceBId;

    // Moving a door to different zones is a structural change: it redefines
    // what a tap on it means. A device already paired here has the old pair
    // cached and would keep counting the old crossing.
    const movesEndpoints = spaceAId !== existingCheckpoint.spaceAId || spaceBId !== existingCheckpoint.spaceBId;
    if (movesEndpoints) {
      const paired = await activeDeviceSessionsFor(checkpointId);
      if (paired.length > 0) {
        return refuseStructuralEdit(reply, paired.length, 'changer ses zones');
      }
    }

    const existingSpaces = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();
    const spacesMap = new Map(existingSpaces.map((s) => [s.id, s]));
    // Validated against the *proposed* endpoints, with exactly the rules
    // creation uses — an endpoint belonging to another event is simply not
    // in this map, so it fails as unknown rather than being trusted.
    const cpError = validateCheckpointRules({ spaceAId, spaceBId, allowAToB, allowBToA }, spacesMap);
    if (cpError) {
      return reply.status(400).send(createProblemDetails(400, 'VALIDATION_ERROR', 'Checkpoint invalide', cpError.message));
    }

    await db
      .update(checkpoints)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.spaceAId !== undefined ? { spaceAId: patch.spaceAId } : {}),
        ...(patch.spaceBId !== undefined ? { spaceBId: patch.spaceBId } : {}),
        ...(patch.allowAToB !== undefined ? { allowAToB: patch.allowAToB } : {}),
        ...(patch.allowBToA !== undefined ? { allowBToA: patch.allowBToA } : {}),
        ...(patch.labelAToB !== undefined ? { labelAToB: patch.labelAToB.trim() } : {}),
        ...(patch.labelBToA !== undefined ? { labelBToA: patch.labelBToA.trim() } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        updatedAtMs: Date.now(),
      })
      .where(eq(checkpoints.id, checkpointId));

    const updated = await db.select().from(checkpoints).where(eq(checkpoints.id, checkpointId)).get();
    return reply.status(200).send(updated);
  });

  // DELETE /api/v1/events/:id/checkpoints/:checkpointId
  app.delete('/api/v1/events/:id/checkpoints/:checkpointId', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id: eventId, checkpointId } = req.params as { id: string; checkpointId: string };
    if (!(await requireDraftEvent(reply, eventId))) return;

    const existingCheckpoint = await db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.eventId, eventId)))
      .get();
    if (!existingCheckpoint) {
      return reply.status(404).send(createProblemDetails(404, 'CHECKPOINT_NOT_FOUND', 'Checkpoint introuvable', 'Checkpoint introuvable.'));
    }

    // `device_sessions.checkpoint_id` is a non-null foreign key at this
    // checkpoint, so a paired device does not merely lose meaning here — the
    // row cannot go while the session points at it.
    const paired = await activeDeviceSessionsFor(checkpointId);
    if (paired.length > 0) {
      return refuseStructuralEdit(reply, paired.length, 'supprimer cette porte');
    }

    // A movement recorded here would make this door part of the ledger, and
    // the ledger is append-only. Counting requires `live`, so a draft should
    // never have one — asserted rather than assumed, because the cost of
    // being wrong is a deleted row the ledger still references.
    const recorded = await db
      .select()
      .from(movements)
      .where(eq(movements.checkpointId, checkpointId))
      .get();
    if (recorded) {
      return reply
        .status(409)
        .send(
          createProblemDetails(
            409,
            'CHECKPOINT_IN_USE',
            'Porte déjà utilisée',
            'Des mouvements ont déjà été enregistrés sur cette porte ; elle ne peut plus être supprimée.'
          )
        );
    }

    // What remains are this door's own preparation artefacts: QR invitations
    // minted for it, and sessions already revoked. Both are non-null foreign
    // keys, so the delete cannot proceed around them, and both are
    // meaningless once the door is gone. They go with it, in one transaction
    // so a failure leaves the door and its artefacts consistent.
    try {
      sqlite.exec('BEGIN IMMEDIATE;');
      sqlite.prepare('DELETE FROM device_sessions WHERE checkpoint_id = ?').run(checkpointId);
      sqlite.prepare('DELETE FROM device_invites WHERE checkpoint_id = ?').run(checkpointId);
      sqlite.prepare('DELETE FROM checkpoints WHERE id = ?').run(checkpointId);
      sqlite.exec('COMMIT;');
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK;');
      } catch {
        // A failed ROLLBACK must not mask the error that caused it.
      }
      throw err;
    }

    return reply.status(200).send({ success: true });
  });
}
