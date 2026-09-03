import { FastifyInstance, FastifyReply } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import type { ZodIssue } from 'zod';
import { AppDb } from '../db/index.js';
import { Env } from '../config/env.js';
import { spaces, checkpoints } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  CreateSpaceRequestSchema,
  UpdateSpaceRequestSchema,
  CreateCheckpointRequestSchema,
  UpdateCheckpointRequestSchema,
  CreateEventDraftRequestSchema,
  createProblemDetails,
} from '@paxflux/shared';
import { requireStaffAuth } from '../auth/staff-sessions.js';
import { createEventDraftAtomic } from '../domain/topology.js';
import { withEventLock } from '../domain/event-lock.js';
import {
  DraftRefusal,
  DraftResult,
  createCheckpointSync,
  createSpaceSync,
  deleteCheckpointSync,
  deleteSpaceSync,
  patchCheckpointSync,
  patchSpaceSync,
} from '../domain/draft-topology.js';

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

  /**
   * Every draft-only mutation below has the same three-step shape:
   *
   *   1. authorize and parse — awaited, and touching nothing that can change;
   *   2. take the event lock, so `POST /start` cannot run between our
   *      precondition and our write (`domain/event-lock.ts`);
   *   3. decide and write in one synchronous SQLite transaction, which
   *      re-reads the draft status and the checkpoint's active pairings
   *      inside the same transaction that writes (`domain/draft-topology.ts`).
   *
   * Step 3 is what makes the decision indivisible against device pairing,
   * which takes no lock but runs its own synchronous `BEGIN IMMEDIATE`.
   */
  function sendRefusal(reply: FastifyReply, refusal: DraftRefusal) {
    return reply
      .status(refusal.status)
      .send(createProblemDetails(refusal.status, refusal.code, refusal.title, refusal.detail));
  }

  function settle<T>(reply: FastifyReply, result: DraftResult<T>, okStatus: number) {
    return result.ok ? reply.status(okStatus).send(result.row) : sendRefusal(reply, result);
  }

  function invalidBody(reply: FastifyReply, detail: string) {
    return reply.status(400).send(createProblemDetails(400, 'VALIDATION_ERROR', 'Paramètres invalides', detail));
  }

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
    const parseResult = CreateSpaceRequestSchema.safeParse(req.body);
    if (!parseResult.success) return invalidBody(reply, 'Données d’espace invalides.');

    return withEventLock(eventId, async () =>
      settle(reply, createSpaceSync(sqlite, eventId, parseResult.data), 201)
    );
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
    const parseResult = CreateCheckpointRequestSchema.safeParse(req.body);
    if (!parseResult.success) return invalidBody(reply, 'Données de checkpoint invalides.');

    return withEventLock(eventId, async () =>
      settle(reply, createCheckpointSync(sqlite, eventId, parseResult.data), 201)
    );
  });

  // PATCH /api/v1/events/:id/spaces/:spaceId
  app.patch('/api/v1/events/:id/spaces/:spaceId', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id: eventId, spaceId } = req.params as { id: string; spaceId: string };
    const parseResult = UpdateSpaceRequestSchema.safeParse(req.body);
    if (!parseResult.success) return invalidBody(reply, 'Données d’espace invalides.');

    return withEventLock(eventId, async () =>
      settle(reply, patchSpaceSync(sqlite, eventId, spaceId, parseResult.data), 200)
    );
  });

  // DELETE /api/v1/events/:id/spaces/:spaceId
  app.delete('/api/v1/events/:id/spaces/:spaceId', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id: eventId, spaceId } = req.params as { id: string; spaceId: string };
    return withEventLock(eventId, async () => settle(reply, deleteSpaceSync(sqlite, eventId, spaceId), 200));
  });

  // PATCH /api/v1/events/:id/checkpoints/:checkpointId
  app.patch('/api/v1/events/:id/checkpoints/:checkpointId', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id: eventId, checkpointId } = req.params as { id: string; checkpointId: string };
    const parseResult = UpdateCheckpointRequestSchema.safeParse(req.body);
    if (!parseResult.success) return invalidBody(reply, 'Données de checkpoint invalides.');

    return withEventLock(eventId, async () =>
      settle(reply, patchCheckpointSync(sqlite, eventId, checkpointId, parseResult.data), 200)
    );
  });

  // DELETE /api/v1/events/:id/checkpoints/:checkpointId
  app.delete('/api/v1/events/:id/checkpoints/:checkpointId', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id: eventId, checkpointId } = req.params as { id: string; checkpointId: string };
    return withEventLock(eventId, async () =>
      settle(reply, deleteCheckpointSync(sqlite, eventId, checkpointId), 200)
    );
  });
}
