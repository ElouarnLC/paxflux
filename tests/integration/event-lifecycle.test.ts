import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { instanceSettings } from '../../apps/server/src/db/schema.js';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

describe('Event lifecycle transitions & preflight', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];
  let env: ReturnType<typeof parseEnv>;
  let csrfToken: string;
  let sessionCookie: { name: string; value: string };

  beforeEach(async () => {
    env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: './tests/scratch-lifecycle-data',
    });
    const dbConn = createDatabase(':memory:');
    sqlite = dbConn.sqlite;
    db = dbConn.db;
    app = await buildApp({ env, dbConnection: dbConn });

    const rawSetupToken = 'test-valid-setup-token-1234567890abcdef';
    const setupTokenHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
    await db
      .update(instanceSettings)
      .set({ setupTokenHash, setupTokenExpiresAtMs: Date.now() + 3_600_000 })
      .where(eq(instanceSettings.id, 1));

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { setupToken: rawSetupToken, username: 'lifecycle_admin', password: 'AdminPassword123!' },
    });
    csrfToken = setupRes.json().csrfToken;
    sessionCookie = setupRes.cookies[0];
  });

  afterEach(async () => {
    await app.close();
    sqlite.close();
  });

  function authHeaders(extra: Record<string, string> = {}) {
    return {
      cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      'x-csrf-token': csrfToken,
      ...extra,
    };
  }

  async function createDraftEvent() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: authHeaders(),
      payload: { name: 'Lifecycle Test Event', capacity: 100 },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function addCheckpoint(eventId: string) {
    const spacesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${eventId}/spaces`,
      headers: authHeaders(),
    });
    const spacesList = spacesRes.json();
    const extSpace = spacesList.find((s: any) => s.kind === 'external');
    const siteSpace = spacesList.find((s: any) => s.kind === 'leaf');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/checkpoints`,
      headers: authHeaders(),
      payload: {
        name: 'Porte Principale',
        spaceAId: extSpace.id,
        spaceBId: siteSpace.id,
        allowAToB: true,
        allowBToA: true,
        labelAToB: 'Entrée',
        labelBToA: 'Sortie',
      },
    });
    expect(res.statusCode).toBe(201);
  }

  describe('GET /api/v1/events/:id/preflight', () => {
    it('reports not ready for a fresh draft event with no checkpoint yet', async () => {
      const event = await createDraftEvent();

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/events/${event.id}/preflight`,
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ready).toBe(false);
      expect(body.error.code).toBe('NO_ACTIVE_CHECKPOINTS');
    });

    it('reports ready once the draft event has an active checkpoint', async () => {
      const event = await createDraftEvent();
      await addCheckpoint(event.id);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/events/${event.id}/preflight`,
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ready: true, error: null });
    });

    it('reports not ready (and does not mutate) for an event that is already live', async () => {
      const event = await createDraftEvent();
      await addCheckpoint(event.id);
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/start`, headers: authHeaders() });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/events/${event.id}/preflight`,
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ready).toBe(false);
      expect(body.error.code).toBe('INVALID_LIFECYCLE_TRANSITION');
    });

    it('404s for a nonexistent event', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/events/${crypto.randomUUID()}/preflight`,
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('invalid lifecycle transitions are rejected', () => {
    it('POST /start on a draft event with no checkpoints fails the same preflight check', async () => {
      const event = await createDraftEvent();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${event.id}/start`,
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('NO_ACTIVE_CHECKPOINTS');

      const stillDraft = await app.inject({
        method: 'GET',
        url: `/api/v1/events/${event.id}`,
        headers: authHeaders(),
      });
      expect(stillDraft.json().status).toBe('draft');
    });

    it('POST /start on an already-live event is rejected (409)', async () => {
      const event = await createDraftEvent();
      await addCheckpoint(event.id);
      const first = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/start`, headers: authHeaders() });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/start`, headers: authHeaders() });
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('INVALID_LIFECYCLE_TRANSITION');
    });

    it('POST /begin-closing on a draft event is rejected (409)', async () => {
      const event = await createDraftEvent();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${event.id}/begin-closing`,
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('INVALID_LIFECYCLE_TRANSITION');
    });

    it('POST /close on a draft event is rejected (409)', async () => {
      const event = await createDraftEvent();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${event.id}/close`,
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('INVALID_LIFECYCLE_TRANSITION');
    });

    it('live -> closing -> closed follows the minimum required path', async () => {
      const event = await createDraftEvent();
      await addCheckpoint(event.id);
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/start`, headers: authHeaders() });

      const closing = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/begin-closing`, headers: authHeaders() });
      expect(closing.statusCode).toBe(200);
      expect(closing.json().status).toBe('closing');

      const closed = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/close`, headers: authHeaders() });
      expect(closed.statusCode).toBe(200);
      expect(closed.json().status).toBe('closed');
    });
  });
});
