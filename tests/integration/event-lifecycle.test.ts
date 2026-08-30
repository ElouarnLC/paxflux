import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { instanceSettings, staffUsers, deviceSessions, auditLog } from '../../apps/server/src/db/schema.js';
import { createStaffSession } from '../../apps/server/src/auth/staff-sessions.js';
import { COOKIE_NAME_STAFF } from '@paxflux/shared';
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
      BACKUP_DIR: './tests/scratch-lifecycle-backups',
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
    return res.json();
  }

  async function startLiveEvent() {
    const event = await createDraftEvent();
    const checkpoint = await addCheckpoint(event.id);
    const startRes = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/start`, headers: authHeaders() });
    expect(startRes.statusCode).toBe(200);
    return { event, checkpoint };
  }

  async function pairDevice(eventId: string, checkpointId: string): Promise<string> {
    const inviteRes = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/device-invites`,
      headers: authHeaders(),
      payload: { checkpointId, expiresInMinutes: 30 },
    });
    expect(inviteRes.statusCode).toBe(201);
    const { token } = inviteRes.json();

    const pairRes = await app.inject({
      method: 'POST',
      url: '/api/v1/device/pair',
      payload: { token, appVersion: '1.0.0' },
    });
    expect(pairRes.statusCode).toBe(200);
    return pairRes.json().deviceSession.id as string;
  }

  async function setDeviceSyncState(deviceSessionId: string, opts: { online: boolean; pendingCount: number }) {
    await db
      .update(deviceSessions)
      .set({
        lastSeenAtMs: opts.online ? Date.now() : Date.now() - 120_000,
        lastPendingCount: opts.pendingCount,
      })
      .where(eq(deviceSessions.id, deviceSessionId));
  }

  async function createSupervisorAuth() {
    const userId = crypto.randomUUID();
    const now = Date.now();
    await db.insert(staffUsers).values({
      id: userId,
      username: 'supervisor1',
      usernameNormalized: 'supervisor1',
      displayName: 'Supervisor',
      role: 'supervisor',
      passwordHash: 'unused-in-this-test',
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });
    const session = await createStaffSession(db, userId, 12);
    return {
      cookie: `${COOKIE_NAME_STAFF}=${session.sessionToken}`,
      csrfToken: session.csrfToken,
    };
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

    it('POST /close on a live event (skipping closing) is rejected (409) — live can never close directly', async () => {
      const { event } = await startLiveEvent();

      const res = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/close`, headers: authHeaders() });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('INVALID_LIFECYCLE_TRANSITION');
    });
  });

  describe('POST /close requires every active device to be synced', () => {
    it('rejects with 409 DEVICES_NOT_SYNCED when a device is still offline', async () => {
      const { event, checkpoint } = await startLiveEvent();
      const deviceId = await pairDevice(event.id, checkpoint.id);
      await setDeviceSyncState(deviceId, { online: false, pendingCount: 0 });
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/begin-closing`, headers: authHeaders() });

      const res = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/close`, headers: authHeaders() });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DEVICES_NOT_SYNCED');
    });

    it('rejects with 409 DEVICES_NOT_SYNCED when an online device still has a pending count', async () => {
      const { event, checkpoint } = await startLiveEvent();
      const deviceId = await pairDevice(event.id, checkpoint.id);
      await setDeviceSyncState(deviceId, { online: true, pendingCount: 3 });
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/begin-closing`, headers: authHeaders() });

      const res = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/close`, headers: authHeaders() });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DEVICES_NOT_SYNCED');
    });

    it('succeeds once the only active device is online with no pending actions', async () => {
      const { event, checkpoint } = await startLiveEvent();
      const deviceId = await pairDevice(event.id, checkpoint.id);
      await setDeviceSyncState(deviceId, { online: true, pendingCount: 0 });
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/begin-closing`, headers: authHeaders() });

      const res = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/close`, headers: authHeaders() });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('closed');
    });
  });

  describe('POST /force-close', () => {
    it('is rejected for a non-admin (supervisor) session (403)', async () => {
      const { event, checkpoint } = await startLiveEvent();
      const deviceId = await pairDevice(event.id, checkpoint.id);
      await setDeviceSyncState(deviceId, { online: false, pendingCount: 5 });
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/begin-closing`, headers: authHeaders() });

      const supervisor = await createSupervisorAuth();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${event.id}/force-close`,
        headers: { cookie: supervisor.cookie, 'x-csrf-token': supervisor.csrfToken },
        payload: { reason: 'Site evacuation' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('requires a reason of at least 3 characters (400 without one)', async () => {
      const { event } = await startLiveEvent();
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/begin-closing`, headers: authHeaders() });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${event.id}/force-close`,
        headers: authHeaders(),
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('bypasses the device-sync check for an admin with a reason, and writes an audit log entry', async () => {
      const { event, checkpoint } = await startLiveEvent();
      const deviceId = await pairDevice(event.id, checkpoint.id);
      await setDeviceSyncState(deviceId, { online: false, pendingCount: 7 });
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/begin-closing`, headers: authHeaders() });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${event.id}/force-close`,
        headers: authHeaders(),
        payload: { reason: 'Weather emergency, evacuating the site' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('closed');

      const auditRow = await db.select().from(auditLog).where(eq(auditLog.action, 'FORCE_CLOSE')).get();
      expect(auditRow).toBeTruthy();
      expect(auditRow?.eventId).toBe(event.id);
      const metadata = auditRow?.metadata as { reason: string; unsyncedDeviceCount: number };
      expect(metadata.reason).toBe('Weather emergency, evacuating the site');
      expect(metadata.unsyncedDeviceCount).toBe(1);
    });

    it('is rejected (409) when the event is not in `closing`', async () => {
      const { event } = await startLiveEvent();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${event.id}/force-close`,
        headers: authHeaders(),
        payload: { reason: 'Trying to force-close a live event' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('closed -> reopen / archived', () => {
    async function closeEvent() {
      const { event } = await startLiveEvent();
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/begin-closing`, headers: authHeaders() });
      const closeRes = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/close`, headers: authHeaders() });
      expect(closeRes.statusCode).toBe(200);
      return event;
    }

    it('POST /reopen requires admin, a reason, and moves closed -> live', async () => {
      const event = await closeEvent();

      const noReason = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/reopen`, headers: authHeaders(), payload: {} });
      expect(noReason.statusCode).toBe(400);

      const supervisor = await createSupervisorAuth();
      const asSupervisor = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${event.id}/reopen`,
        headers: { cookie: supervisor.cookie, 'x-csrf-token': supervisor.csrfToken },
        payload: { reason: 'Investigating a discrepancy' },
      });
      expect(asSupervisor.statusCode).toBe(403);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${event.id}/reopen`,
        headers: authHeaders(),
        payload: { reason: 'Investigating a discrepancy' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('live');
    });

    it('POST /archive requires admin and moves closed -> archived', async () => {
      const event = await closeEvent();

      const supervisor = await createSupervisorAuth();
      const asSupervisor = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${event.id}/archive`,
        headers: { cookie: supervisor.cookie, 'x-csrf-token': supervisor.csrfToken },
      });
      expect(asSupervisor.statusCode).toBe(403);

      const res = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/archive`, headers: authHeaders() });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('archived');
    });

    it('an archived event accepts no further lifecycle transitions', async () => {
      const event = await closeEvent();
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/archive`, headers: authHeaders() });

      const reopenRes = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${event.id}/reopen`,
        headers: authHeaders(),
        payload: { reason: 'Trying to reopen an archived event' },
      });
      expect(reopenRes.statusCode).toBe(409);
    });
  });
});
