import { FastifyInstance } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { AppDb } from '../db/index.js';
import { Env } from '../config/env.js';
import { backupRecords, events } from '../db/schema.js';
import { desc, count, eq } from 'drizzle-orm';
import { requireStaffAuth } from '../auth/staff-sessions.js';
import { createDatabaseBackup } from '../backups/backup-service.js';
import { computeEventAnalytics } from '../domain/analytics.js';
import { broadcaster } from '../realtime/broadcaster.js';
import { createProblemDetails, SystemStatusResponse } from '@paxflux/shared';

const serverStartTimeMs = Date.now();

export async function registerSystemRoutes(
  app: FastifyInstance,
  sqlite: DatabaseSync,
  db: AppDb,
  env: Env
) {
  // GET /health/live
  app.get('/health/live', async (_req, reply) => {
    return reply.status(200).send({ status: 'ok', time: Date.now() });
  });

  // GET /health/ready
  app.get('/health/ready', async (_req, reply) => {
    try {
      const row = sqlite.prepare('SELECT 1 as alive;').get() as { alive?: number };
      if (!row || row.alive !== 1) {
        return reply.status(503).send({ status: 'error', reason: 'Database query failed' });
      }
      return reply.status(200).send({ status: 'ready', time: Date.now() });
    } catch (err: any) {
      return reply.status(503).send({ status: 'error', reason: err.message });
    }
  });

  // GET /api/v1/events/:id/analytics
  app.get('/api/v1/events/:id/analytics', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env);
    if (!sessionData) return;

    const { id: eventId } = req.params as { id: string };
    const analytics = await computeEventAnalytics(db, eventId);

    if (!analytics) {
      return reply.status(404).send(createProblemDetails(404, 'EVENT_NOT_FOUND', 'Événement introuvable', 'Événement introuvable.'));
    }

    return reply.status(200).send(analytics);
  });

  // GET /api/v1/system/status
  app.get('/api/v1/system/status', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    let dbSizeBytes = 0;
    let walSizeBytes = 0;
    const dbPath = path.resolve(env.DATA_DIR, 'app.db');
    const walPath = path.resolve(env.DATA_DIR, 'app.db-wal');

    if (fs.existsSync(dbPath)) {
      dbSizeBytes = fs.statSync(dbPath).size;
    }
    if (fs.existsSync(walPath)) {
      walSizeBytes = fs.statSync(walPath).size;
    }

    let quickCheckOk = false;
    try {
      const checkRow = sqlite.prepare('PRAGMA quick_check;').get() as { quick_check?: string } | undefined;
      quickCheckOk = checkRow?.quick_check === 'ok';
    } catch {
      quickCheckOk = false;
    }

    const lastBackup = await db
      .select()
      .from(backupRecords)
      .orderBy(desc(backupRecords.id))
      .limit(1)
      .get();

    const activeEventsCount = await db
      .select({ count: count() })
      .from(events)
      .where(eq(events.status, 'live'))
      .get();

    const response: SystemStatusResponse = {
      version: '1.0.0',
      buildId: process.env.BUILD_ID || 'v1.0.0-prod',
      nodeVersion: process.version,
      uptimeSeconds: Math.floor((Date.now() - serverStartTimeMs) / 1000),
      database: {
        sizeBytes: dbSizeBytes,
        walSizeBytes,
        quickCheckOk,
        lastBackupTimeMs: lastBackup ? lastBackup.createdAtMs : null,
      },
      connectedSSECount: broadcaster.getConnectedClientCount(),
      activeEventsCount: activeEventsCount?.count || 0,
    };

    return reply.status(200).send(response);
  });

  // GET /api/v1/system/backups
  app.get('/api/v1/system/backups', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const list = await db
      .select()
      .from(backupRecords)
      .orderBy(desc(backupRecords.id))
      .limit(100)
      .all();

    return reply.status(200).send(list);
  });

  // POST /api/v1/system/backups
  app.post('/api/v1/system/backups', async (req, reply) => {
    const sessionData = await requireStaffAuth(req, reply, db, env, 'admin');
    if (!sessionData) return;

    const { reason } = (req.body as { reason?: string }) || {};

    try {
      const backup = await createDatabaseBackup(sqlite, db, env, reason || 'manual_admin');
      return reply.status(201).send(backup);
    } catch (err: any) {
      return reply
        .status(500)
        .send(createProblemDetails(500, 'BACKUP_FAILED', 'Échec de sauvegarde', err.message));
    }
  });
}
