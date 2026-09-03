import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppDb } from '../db/index.js';
import { Env } from '../config/env.js';
import { events, spaces, spaceState, checkpoints, auditLog, deviceSessions } from '../db/schema.js';
import { eq, desc, and, isNull } from 'drizzle-orm';
import {
  CreateEventRequestSchema,
  UpdateEventRequestSchema,
  createProblemDetails,
  isValidTimezone,
  PreflightResponse,
} from '@paxflux/shared';
import { requireStaffAuth } from '../auth/staff-sessions.js';
import { withEventLock } from '../domain/event-lock.js';
import { markEventLiveSync, patchDraftEventSync } from '../domain/draft-topology.js';
import {
  validateEventForLive,
  getUnsyncedActiveDevices,
  getCompactEventState,
} from '../domain/events.js';
import { createDatabaseBackup } from '../backups/backup-service.js';
import { broadcaster } from '../realtime/broadcaster.js';

export async function registerEventRoutes(app: FastifyInstance, sqlite: DatabaseSync, db: AppDb, env: Env) {
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
  //
  // Serving two callers with different needs: the supervision surface, which
  // legitimately adjusts a *live* event's capacity (audited below), and the
  // draft editor, which must never touch anything but a draft. They are told
  // apart by `expectedStatus`, a precondition the editor always sends and
  // the supervision surface never does — so neither constrains the other.
  //
  // That split carries authorization with it. Supervision stays open to any
  // authenticated staff member; the editor path is admin-only, matching
  // every other mutation the editor makes.
  app.patch('/api/v1/events/:id', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };

    // Under the event lock for the same reason the topology routes are:
    // `POST /start` is the only transition out of `draft`, it holds this
    // lock across its awaited pre-live backup, and a decision about
    // draftness taken outside it would be a decision about the past.
    return withEventLock(id, async () => {
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

      const { expectedStatus, ...updates } = parseResult.data;

      // The editor path is an admin surface, and this is where that starts.
      //
      // Authentication above is deliberately role-free: the supervision
      // screen legitimately adjusts a live event's capacity, and tightening
      // the whole route would take that away. But `expectedStatus` is what
      // marks a request as coming from the draft editor, and every other
      // mutation that editor makes — spaces, checkpoints — already requires
      // admin. Without this check a supervisor could reach the one part of
      // the preparation surface that happens to share a route with
      // supervision, and rewrite a draft's name, capacity and timezone.
      //
      // Checked the moment the request is known to be an editor request:
      // before the timezone rules, before the precondition, before anything
      // is written. A 403 here has evaluated nothing and changed nothing.
      if (expectedStatus === 'draft' && sessionData.user.role !== 'admin') {
        return reply
          .status(403)
          .send(createProblemDetails(403, 'FORBIDDEN', 'Accès interdit', 'Droits administrateur requis.'));
      }

      const now = Date.now();

      // Timezone is preparation, not operation.
      //
      // Every movement already recorded was read in the event's zone, and
      // the exports draw their day boundaries from it. Changing it after
      // counting has begun would silently re-cut a ledger that is
      // append-only by design, so a *change* is accepted only while the
      // event is still a draft — and only to a real IANA zone. Resending the
      // value already stored is not a change: that is what lets an event
      // created before RC2-C, whose timezone the current validator would
      // reject, still be renamed. This deliberately does not tighten any
      // other field's authorization.
      if (updates.timezone !== undefined && updates.timezone !== eventRecord.timezone) {
        if (eventRecord.status !== 'draft') {
          return reply
            .status(409)
            .send(
              createProblemDetails(
                409,
                'TIMEZONE_LOCKED',
                'Fuseau horaire verrouillé',
                'Le fuseau horaire ne peut être modifié que tant que l’événement est un brouillon.'
              )
            );
        }
        if (!isValidTimezone(updates.timezone)) {
          return reply
            .status(400)
            .send(
              createProblemDetails(
                400,
                'VALIDATION_ERROR',
                'Fuseau horaire invalide',
                'Identifiant de fuseau horaire IANA invalide.',
                undefined,
                [{ name: 'timezone', reason: 'Identifiant de fuseau horaire IANA invalide.' }]
              )
            );
        }
      }

      // The draft editor's path: the precondition is re-read inside the
      // transaction that writes, so it is true at the instant of the write
      // rather than at some earlier moment the client hoped was close enough.
      if (expectedStatus === 'draft') {
        const outcome = patchDraftEventSync(sqlite, id, updates);
        if (!outcome.ok) {
          return reply
            .status(outcome.status)
            .send(createProblemDetails(outcome.status, outcome.code, outcome.title, outcome.detail));
        }
        const written = await db.select().from(events).where(eq(events.id, id)).get();
        return reply.status(200).send(written);
      }

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
  });

  // GET /api/v1/events/:id/preflight
  app.get('/api/v1/events/:id/preflight', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, id)).get();

    if (!eventRecord) {
      return reply.status(404).send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Événement introuvable.'));
    }

    if (eventRecord.status !== 'draft') {
      const response: PreflightResponse = {
        ready: false,
        error: {
          code: 'INVALID_LIFECYCLE_TRANSITION',
          message: 'Seul un événement en brouillon peut être démarré.',
        },
      };
      return reply.status(200).send(response);
    }

    const allSpaces = await db.select().from(spaces).where(eq(spaces.eventId, id)).all();
    const allCheckpoints = await db.select().from(checkpoints).where(eq(checkpoints.eventId, id)).all();

    // Reuses the exact same check POST /start performs, so preflight can
    // never claim "ready" for a topology that /start would then reject.
    const validationError = validateEventForLive(
      { capacity: eventRecord.capacity },
      allSpaces,
      allCheckpoints
    );

    const response: PreflightResponse = {
      ready: validationError === null,
      error: validationError,
    };
    return reply.status(200).send(response);
  });

  // POST /api/v1/events/:id/start
  app.post('/api/v1/events/:id/start', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };

    // The whole transition is one critical section.
    //
    // Reading the topology, validating it, taking the pre-live backup and
    // flipping the status are four awaited steps, and every draft-only
    // mutation takes this same lock. That is what makes the boundary
    // linearizable: a topology edit either lands entirely before this
    // section — in which case the edited topology is what gets validated and
    // what the pre-live recovery point captures — or entirely after it, by
    // which point the event is live and the edit is refused with
    // TOPOLOGY_LOCKED. There is no interleaving in which a mutation commits
    // between the validation and the lock, so the topology made live can
    // never differ from the one whose readiness was accepted.
    return withEventLock(id, async () => {
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
        allSpaces,
        allCheckpoints
      );

      if (validationError) {
        return reply.status(400).send(createProblemDetails(400, validationError.code as any, 'Topologie invalide pour le live', validationError.message));
      }

      // SPEC §5.2: draft -> live requires a healthy database and an
      // acceptable/immediate backup. A fresh backup verified with
      // PRAGMA quick_check satisfies both in one action. It is taken after
      // validation and before the flip, with the lock held, so the snapshot
      // is of exactly the topology that was just accepted.
      const backupResult = await createDatabaseBackup(sqlite, db, env, 'pre_live');
      if (!backupResult.quickCheckOk) {
        return reply
          .status(503)
          .send(
            createProblemDetails(
              503,
              'DATABASE_INTEGRITY_CHECK_FAILED',
              'Base de données non saine',
              "La vérification d'intégrité de la base de données a échoué juste avant le passage en direct. L'événement n'a pas été démarré."
            )
          );
      }

      // Conditional on `status = 'draft'` as a last word independent of the
      // lock: if this ever returns false the event was started by something
      // that did not hold it, and reporting a start would be a lie.
      const now = Date.now();
      if (!markEventLiveSync(sqlite, id, now)) {
        return reply.status(409).send(createProblemDetails(409, 'INVALID_LIFECYCLE_TRANSITION', 'Transition invalide', 'Seul un événement en brouillon peut être démarré.'));
      }

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

    // A new epoch invalidates every previous drain acknowledgment. What a
    // device said about an earlier closing — or about the live phase — says
    // nothing about this one, and re-opening then re-closing an event must
    // require every device to confirm again.
    await db
      .update(deviceSessions)
      .set({ drainedForClosingAtMs: null })
      .where(eq(deviceSessions.eventId, id));

    broadcaster.broadcastMessage(id, {
      type: 'event-status',
      data: {
        eventId: id,
        status: 'closing',
        version: eventRecord.version,
        timestampMs: now,
      },
    });

    // Also push the state, which carries `closingStartedAtMs`: a device
    // needs the epoch itself to acknowledge it, and the status message
    // alone would leave one that reconnects later unable to name it.
    const closingState = await getCompactEventState(db, id);
    if (closingState) {
      broadcaster.broadcastState(id, closingState);
    }

    const updated = await db.select().from(events).where(eq(events.id, id)).get();
    return reply.status(200).send(updated);
  });

  // POST /api/v1/events/:id/close — normal close (SPEC §5.4): only once
  // every active device has synced. Use /force-close otherwise.
  app.post('/api/v1/events/:id/close', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, id)).get();

    if (!eventRecord || eventRecord.status !== 'closing') {
      return reply.status(409).send(createProblemDetails(409, 'INVALID_LIFECYCLE_TRANSITION', 'Transition invalide', 'L’événement doit être en cours de fermeture pour être clôturé.'));
    }

    const unsyncedDevices = await getUnsyncedActiveDevices(db, id);
    if (unsyncedDevices.length > 0) {
      return reply.status(409).send(
        createProblemDetails(
          409,
          'DEVICES_NOT_SYNCED',
          'Appareils non synchronisés',
          `${unsyncedDevices.length} appareil(s) actif(s) ne sont pas encore hors ligne ou synchronisés. Utilisez la fermeture forcée si nécessaire.`
        )
      );
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

  // POST /api/v1/events/:id/force-close — admin-only escape hatch from
  // /close's device-sync requirement (SPEC §5.4: "fermeture forcée,
  // nécessitant une confirmation forte et un motif d'audit").
  app.post('/api/v1/events/:id/force-close', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason?: string };

    if (!reason || reason.trim().length < 3) {
      return reply.status(400).send(createProblemDetails(400, 'VALIDATION_ERROR', 'Motif requis', 'Un motif explicite est requis pour une fermeture forcée.'));
    }

    const eventRecord = await db.select().from(events).where(eq(events.id, id)).get();
    if (!eventRecord || eventRecord.status !== 'closing') {
      return reply.status(409).send(createProblemDetails(409, 'INVALID_LIFECYCLE_TRANSITION', 'Transition invalide', 'L’événement doit être en cours de fermeture pour être clôturé.'));
    }

    const unsyncedDevices = await getUnsyncedActiveDevices(db, id);
    const now = Date.now();

    await db
      .update(events)
      .set({
        status: 'closed',
        closedAtMs: now,
        updatedAtMs: now,
      })
      .where(eq(events.id, id));

    await db.insert(auditLog).values({
      eventId: id,
      actorUserId: sessionData.user.id,
      action: 'FORCE_CLOSE',
      entityType: 'event',
      entityId: id,
      metadata: {
        reason: reason.trim(),
        unsyncedDeviceCount: unsyncedDevices.length,
        unsyncedDevices,
      },
      createdAtMs: now,
    });

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
        // The closing epoch is over. Leaving it set would let a stale
        // acknowledgment satisfy the *next* closing without any device
        // having confirmed anything about it.
        closingStartedAtMs: null,
        updatedAtMs: now,
      })
      .where(eq(events.id, id));

    await db
      .update(deviceSessions)
      .set({ drainedForClosingAtMs: null })
      .where(eq(deviceSessions.eventId, id));

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

    // SPEC §5.1 (`archived`): "les sessions appareils sont révoquées."
    await db
      .update(deviceSessions)
      .set({ revokedAtMs: now })
      .where(and(eq(deviceSessions.eventId, id), isNull(deviceSessions.revokedAtMs)));

    broadcaster.closeAllForEvent(id);

    const updated = await db.select().from(events).where(eq(events.id, id)).get();
    return reply.status(200).send(updated);
  });
}
