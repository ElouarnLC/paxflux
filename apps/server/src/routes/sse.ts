import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { AppDb } from '../db/index.js';
import { Env } from '../config/env.js';
import { authenticateStaffRequest } from '../auth/staff-sessions.js';
import { authenticateDeviceRequest } from '../auth/pairing.js';
import { getCompactEventState } from '../domain/events.js';
import { broadcaster } from '../realtime/broadcaster.js';
import { createProblemDetails } from '@paxflux/shared';

export async function registerSSERoutes(app: FastifyInstance, db: AppDb, env: Env) {
  // GET /api/v1/events/:id/stream (Staff Dashboard SSE)
  app.get('/api/v1/events/:id/stream', async (req, reply) => {
    const sessionData = await authenticateStaffRequest(req, reply, db, env);
    if (!sessionData) {
      return reply
        .status(401)
        .send(createProblemDetails(401, 'UNAUTHORIZED', 'Non authentifié', 'Session superviseur requise pour le flux live.'));
    }

    const { id: eventId } = req.params as { id: string };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const clientId = crypto.randomUUID();
    broadcaster.registerClient({
      id: clientId,
      eventId,
      isStaff: true,
      reply,
    });

    // Send initial snapshot immediately
    const initialState = await getCompactEventState(db, eventId);
    if (initialState) {
      reply.raw.write(`event: state\ndata: ${JSON.stringify(initialState)}\n\n`);
    }
  });

  // GET /api/v1/device/stream (Field Counter SSE)
  app.get('/api/v1/device/stream', async (req, reply) => {
    const deviceSession = await authenticateDeviceRequest(req, db, env);
    if (!deviceSession) {
      return reply
        .status(401)
        .send(createProblemDetails(401, 'UNAUTHORIZED', 'Appareil non appairé', 'Session appareil requise pour le flux.'));
    }

    const eventId = deviceSession.eventId;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const clientId = crypto.randomUUID();
    broadcaster.registerClient({
      id: clientId,
      eventId,
      isStaff: false,
      deviceSessionId: deviceSession.id,
      reply,
    });

    // Send initial snapshot immediately
    const initialState = await getCompactEventState(db, eventId);
    if (initialState) {
      reply.raw.write(`event: state\ndata: ${JSON.stringify(initialState)}\n\n`);
    }
  });
}
