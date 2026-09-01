import { FastifyInstance } from 'fastify';
import { AppDb } from '../db/index.js';
import { Env } from '../config/env.js';
import { events, spaces, checkpoints, movements, deviceSessions, spaceState } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { requireStaffAuth } from '../auth/staff-sessions.js';
import { createProblemDetails } from '@paxflux/shared';

export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = String(value);

  // CSV Formula Injection Neutralization per SPEC §14.3
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  // Escape double quotes and enclose if contains comma, quote, or newline
  if (/[",\n\r]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export async function registerExportRoutes(app: FastifyInstance, db: AppDb, env: Env) {
  // GET /api/v1/events/:id/export/movements.csv
  app.get('/api/v1/events/:id/export/movements.csv', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, eventId)).get();

    if (!eventRecord) {
      return reply.status(404).send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Événement introuvable.'));
    }

    const allSpaces = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();
    const allCheckpoints = await db.select().from(checkpoints).where(eq(checkpoints.eventId, eventId)).all();
    const allDevices = await db.select().from(deviceSessions).where(eq(deviceSessions.eventId, eventId)).all();

    const spaceMap = new Map(allSpaces.map((s) => [s.id, s.name]));
    const cpMap = new Map(allCheckpoints.map((c) => [c.id, c.name]));
    const devMap = new Map(allDevices.map((d) => [d.id, d.label]));

    const movementsList = await db
      .select()
      .from(movements)
      .where(eq(movements.eventId, eventId))
      .orderBy(asc(movements.id))
      .all();

    const headers = [
      'id',
      'server_time_iso',
      'server_time_ms',
      'kind',
      'checkpoint_name',
      'device_label',
      'from_space',
      'to_space',
      'quantity',
      'client_action_id',
      'reverses_movement_id',
      'reason',
      'source',
      'event_version',
    ];

    const rows = movementsList.map((m) => [
      sanitizeCsvCell(m.id),
      sanitizeCsvCell(new Date(m.serverTimeMs).toISOString()),
      sanitizeCsvCell(m.serverTimeMs),
      sanitizeCsvCell(m.kind),
      sanitizeCsvCell(m.checkpointId ? cpMap.get(m.checkpointId) || m.checkpointId : ''),
      sanitizeCsvCell(m.deviceSessionId ? devMap.get(m.deviceSessionId) || m.deviceSessionId : ''),
      sanitizeCsvCell(m.fromSpaceId ? spaceMap.get(m.fromSpaceId) || m.fromSpaceId : 'Extérieur'),
      sanitizeCsvCell(m.toSpaceId ? spaceMap.get(m.toSpaceId) || m.toSpaceId : 'Extérieur'),
      sanitizeCsvCell(m.quantity),
      sanitizeCsvCell(m.clientActionId || ''),
      sanitizeCsvCell(m.reversesMovementId || ''),
      sanitizeCsvCell(m.reason || ''),
      sanitizeCsvCell(m.source),
      sanitizeCsvCell(m.eventVersion),
    ]);

    const csvContent = `\uFEFF${[headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n')}`;

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="paxflux-${eventRecord.slug}-movements.csv"`);
    return reply.status(200).send(csvContent);
  });

  // GET /api/v1/events/:id/export/event.json
  app.get('/api/v1/events/:id/export/event.json', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
    const eventRecord = await db.select().from(events).where(eq(events.id, eventId)).get();

    if (!eventRecord) {
      return reply.status(404).send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Événement introuvable.'));
    }

    const allSpaces = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();
    const allCheckpoints = await db.select().from(checkpoints).where(eq(checkpoints.eventId, eventId)).all();
    const allStates = await db.select().from(spaceState).where(eq(spaceState.eventId, eventId)).all();
    const allMovements = await db.select().from(movements).where(eq(movements.eventId, eventId)).orderBy(asc(movements.id)).all();

    const payload = {
      event: eventRecord,
      spaces: allSpaces,
      checkpoints: allCheckpoints,
      spaceState: allStates,
      movements: allMovements,
      exportedAtIso: new Date().toISOString(),
    };

    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="paxflux-${eventRecord.slug}-full.json"`);
    return reply.status(200).send(payload);
  });
}
