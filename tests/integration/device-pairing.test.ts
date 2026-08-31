import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { instanceSettings, deviceInvites, deviceSessions, checkpoints } from '../../apps/server/src/db/schema.js';
import { exchangeDeviceInvite } from '../../apps/server/src/auth/pairing.js';
import { hashToken } from '../../apps/server/src/auth/csrf.js';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

// Phase 5 — device pairing lifecycle: canonical pairing URL, event <->
// checkpoint consistency, genuinely single-use invitations, and a strict
// heartbeat contract.
describe('Device pairing: canonical URL, consistency, single-use, heartbeat', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];
  let env: ReturnType<typeof parseEnv>;
  let csrfToken: string;
  let sessionCookie: { name: string; value: string };

  async function boot(extraEnv: Record<string, string> = {}) {
    env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: './tests/scratch-pairing-data',
      BACKUP_DIR: './tests/scratch-pairing-backups',
      ...extraEnv,
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
      payload: { setupToken: rawSetupToken, username: 'pairing_admin', password: 'AdminPassword123!' },
    });
    csrfToken = setupRes.json().csrfToken;
    sessionCookie = setupRes.cookies[0];
  }

  beforeEach(async () => {
    await boot();
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

  async function createDraftEvent(name = 'Repro Pairing') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: authHeaders(),
      payload: {
        event: { name, capacity: 100, timezone: 'Europe/Paris' },
        spaces: [
          { clientId: 'ext', name: 'Extérieur', kind: 'external' as const },
          { clientId: 'site', name: 'Site', kind: 'leaf' as const, capacity: 100 },
        ],
        checkpoints: [
          {
            name: 'Porte Principale',
            spaceAClientId: 'ext',
            spaceBClientId: 'site',
            allowAToB: true,
            allowBToA: true,
            labelAToB: 'ENTRÉE +1',
            labelBToA: 'SORTIE −1',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function createInvite(eventId: string, checkpointId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/device-invites`,
      headers: authHeaders(),
      payload: { checkpointId, expiresInMinutes: 30 },
    });
  }

  describe('canonical pairing URL', () => {
    it('uses PUBLIC_BASE_URL verbatim for pairUrl, whatever origin the admin browses from', async () => {
      await app.close();
      sqlite.close();
      await boot({ PUBLIC_BASE_URL: 'https://paxflux.example.test' });

      const { event, checkpoints: cps } = await createDraftEvent('Repro Canonical URL');
      const res = await createInvite(event.id, cps[0].id);

      expect(res.statusCode).toBe(201);
      const invite = res.json();
      expect(invite.pairUrl).toBe(`https://paxflux.example.test/pair#${invite.token}`);
    });

    it('normalizes a trailing slash on PUBLIC_BASE_URL instead of emitting a doubled one', async () => {
      await app.close();
      sqlite.close();
      await boot({ PUBLIC_BASE_URL: 'https://paxflux.example.test/' });

      const { event, checkpoints: cps } = await createDraftEvent('Repro Trailing Slash');
      const res = await createInvite(event.id, cps[0].id);

      const invite = res.json();
      expect(invite.pairUrl).toBe(`https://paxflux.example.test/pair#${invite.token}`);
      expect(invite.pairUrl).not.toContain('//pair');
    });

    it('falls back to the request origin when PUBLIC_BASE_URL is unset, never to a bare relative path', async () => {
      // Local development has no PUBLIC_BASE_URL; the QR must still encode
      // something a phone on the same LAN can actually open, rather than a
      // relative "/pair#token" that resolves to nothing when scanned.
      const { event, checkpoints: cps } = await createDraftEvent('Repro No Public Base URL');
      const res = await createInvite(event.id, cps[0].id);

      const invite = res.json();
      expect(invite.pairUrl).toMatch(/^https?:\/\/[^/]+\/pair#/);
      expect(invite.pairUrl.startsWith('/pair#')).toBe(false);
    });
  });

  describe('event <-> checkpoint consistency', () => {
    it('404s for an unknown event and creates no invite', async () => {
      const res = await createInvite(crypto.randomUUID(), crypto.randomUUID());

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('EVENT_NOT_FOUND');
      const invites = await db.select().from(deviceInvites).all();
      expect(invites).toHaveLength(0);
    });

    it('rejects an unknown checkpoint and creates no invite', async () => {
      const { event } = await createDraftEvent('Repro Unknown Checkpoint');
      const res = await createInvite(event.id, crypto.randomUUID());

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('CHECKPOINT_NOT_FOUND');
      const invites = await db.select().from(deviceInvites).all();
      expect(invites).toHaveLength(0);
    });

    it('rejects a checkpoint that belongs to another event and creates no invite', async () => {
      const eventA = await createDraftEvent('Repro Cross Event A');
      const eventB = await createDraftEvent('Repro Cross Event B');

      const res = await createInvite(eventA.event.id, eventB.checkpoints[0].id);

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('CHECKPOINT_NOT_FOUND');
      const invites = await db.select().from(deviceInvites).all();
      expect(invites).toHaveLength(0);
    });

    it('rejects an inactive checkpoint and creates no invite', async () => {
      const { event, checkpoints: cps } = await createDraftEvent('Repro Inactive Checkpoint');
      await db.update(checkpoints).set({ isActive: false }).where(eq(checkpoints.id, cps[0].id));

      const res = await createInvite(event.id, cps[0].id);

      expect(res.statusCode).toBe(409);
      const invites = await db.select().from(deviceInvites).all();
      expect(invites).toHaveLength(0);
    });

    it('allows invite creation while `draft` and while `live` (SPEC §5.1)', async () => {
      const { event, checkpoints: cps } = await createDraftEvent('Repro Draft And Live');

      const draftInvite = await createInvite(event.id, cps[0].id);
      expect(draftInvite.statusCode).toBe(201);

      const startRes = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/start`, headers: authHeaders() });
      expect(startRes.statusCode).toBe(200);

      const liveInvite = await createInvite(event.id, cps[0].id);
      expect(liveInvite.statusCode).toBe(201);
    });

    it('refuses invite creation once the event is `closing` or beyond, and creates no invite', async () => {
      const { event, checkpoints: cps } = await createDraftEvent('Repro Closing No Invite');
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/start`, headers: authHeaders() });
      await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/begin-closing`, headers: authHeaders() });

      const invitesBefore = await db.select().from(deviceInvites).all();
      const res = await createInvite(event.id, cps[0].id);

      expect(res.statusCode).toBe(409);
      const invitesAfter = await db.select().from(deviceInvites).all();
      expect(invitesAfter).toHaveLength(invitesBefore.length);
    });
  });

  describe('single-use invitations under concurrency', () => {
    it('creates exactly one device session when the same token is exchanged by two concurrent callers', async () => {
      const { event, checkpoints: cps } = await createDraftEvent('Repro Concurrent Pairing');
      const inviteRes = await createInvite(event.id, cps[0].id);
      const { token } = inviteRes.json();

      // Driven at the domain-function level on purpose: two exchanges
      // started in the same tick genuinely interleave at the `await` points
      // the old read-check-write sequence had between reading `usedAtMs`
      // and writing it, and both used to pass the `usedAtMs === null` gate.
      // Routing the same two calls through app.inject would *not* reproduce
      // it — light-my-request dispatches each injected request on its own
      // macrotask, so one handler runs to completion before the other
      // starts, hiding a race that is real in the code.
      const [first, second] = await Promise.all([
        Promise.resolve().then(() => exchangeDeviceInvite(sqlite, token, '1.0.0', env.DEVICE_SESSION_GRACE_HOURS)),
        Promise.resolve().then(() => exchangeDeviceInvite(sqlite, token, '1.0.0', env.DEVICE_SESSION_GRACE_HOURS)),
      ]);

      const outcomes = [first, second];
      const succeeded = outcomes.filter((r) => !('error' in r));
      const refused = outcomes.filter((r) => 'error' in r);

      expect(succeeded).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as { error: string }).error).toBe('INVITE_ALREADY_USED');

      const sessions = await db.select().from(deviceSessions).all();
      expect(sessions).toHaveLength(1);
    });

    it('creates no device session at all when the invite was consumed between the read and the write', async () => {
      const { event, checkpoints: cps } = await createDraftEvent('Repro Consumed Mid Flight');
      const inviteRes = await createInvite(event.id, cps[0].id);
      const { token } = inviteRes.json();

      // Simulates the losing side of a race: by the time this exchange
      // tries to consume the token, another caller already marked it used.
      await db.update(deviceInvites).set({ usedAtMs: Date.now() }).where(eq(deviceInvites.tokenHash, hashToken(token)));

      const result = exchangeDeviceInvite(sqlite, token, '1.0.0', env.DEVICE_SESSION_GRACE_HOURS);

      expect('error' in result && result.error).toBe('INVITE_ALREADY_USED');
      const sessions = await db.select().from(deviceSessions).all();
      expect(sessions).toHaveLength(0);
    });

    it('refuses two concurrent exchanges over HTTP as well', async () => {
      const { event, checkpoints: cps } = await createDraftEvent('Repro Concurrent Pairing HTTP');
      const inviteRes = await createInvite(event.id, cps[0].id);
      const { token } = inviteRes.json();

      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { token, appVersion: '1.0.0' } }),
        app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { token, appVersion: '1.0.0' } }),
      ]);

      const statuses = [first.statusCode, second.statusCode].sort();
      expect(statuses).toEqual([200, 409]);

      const loser = first.statusCode === 200 ? second : first;
      expect(loser.json().code).toBe('INVITE_ALREADY_USED');

      const sessions = await db.select().from(deviceSessions).all();
      expect(sessions).toHaveLength(1);
    });

    it('still refuses a second sequential exchange of the same token', async () => {
      const { event, checkpoints: cps } = await createDraftEvent('Repro Sequential Reuse');
      const inviteRes = await createInvite(event.id, cps[0].id);
      const { token } = inviteRes.json();

      const first = await app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { token } });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { token } });
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('INVITE_ALREADY_USED');

      const sessions = await db.select().from(deviceSessions).all();
      expect(sessions).toHaveLength(1);
    });
  });

  describe('heartbeat validation', () => {
    async function pairDevice() {
      const { event, checkpoints: cps } = await createDraftEvent(`Repro Heartbeat ${crypto.randomUUID()}`);
      const inviteRes = await createInvite(event.id, cps[0].id);
      const { token } = inviteRes.json();
      const pairRes = await app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { token, appVersion: '1.0.0' } });
      const cookie = pairRes.cookies[0];
      return {
        eventId: event.id,
        deviceSessionId: pairRes.json().deviceSession.id as string,
        deviceCookie: `${cookie.name}=${cookie.value}`,
      };
    }

    it('accepts a valid heartbeat and records the reported pending count', async () => {
      const { deviceSessionId, deviceCookie } = await pairDevice();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/device/heartbeat',
        headers: { cookie: deviceCookie },
        payload: { pendingCount: 4, appVersion: '1.0.0' },
      });

      expect(res.statusCode).toBe(200);
      const row = await db.select().from(deviceSessions).where(eq(deviceSessions.id, deviceSessionId)).get();
      expect(row?.lastPendingCount).toBe(4);
    });

    it('rejects a malformed heartbeat with 400 and never rewrites the device sync state', async () => {
      const { deviceSessionId, deviceCookie } = await pairDevice();

      // Establish a known, non-zero pending state first.
      await app.inject({
        method: 'POST',
        url: '/api/v1/device/heartbeat',
        headers: { cookie: deviceCookie },
        payload: { pendingCount: 7, lastClientSequence: 12, appVersion: '1.0.0' },
      });
      const before = await db.select().from(deviceSessions).where(eq(deviceSessions.id, deviceSessionId)).get();
      expect(before?.lastPendingCount).toBe(7);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/device/heartbeat',
        headers: { cookie: deviceCookie },
        payload: { pendingCount: 'beaucoup' },
      });

      // A malformed payload must never be silently coerced into
      // `{ pendingCount: 0 }` — that would tell the supervisor this device
      // has nothing left to sync when it may still hold queued actions.
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');

      const after = await db.select().from(deviceSessions).where(eq(deviceSessions.id, deviceSessionId)).get();
      expect(after?.lastPendingCount).toBe(7);
      expect(after?.lastClientSequence).toBe(12);
      expect(after?.appVersion).toBe('1.0.0');
      expect(after?.lastSeenAtMs).toBe(before?.lastSeenAtMs);
    });

    it('refuses a heartbeat from a revoked session with 401', async () => {
      const { deviceSessionId, deviceCookie } = await pairDevice();

      const revokeRes = await app.inject({
        method: 'POST',
        url: `/api/v1/device-sessions/${deviceSessionId}/revoke`,
        headers: authHeaders(),
      });
      expect(revokeRes.statusCode).toBe(200);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/device/heartbeat',
        headers: { cookie: deviceCookie },
        payload: { pendingCount: 0 },
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
