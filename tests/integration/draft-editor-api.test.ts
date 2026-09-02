import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { staffUsers } from '../../apps/server/src/db/schema.js';
import { hashPassword } from '../../apps/server/src/auth/passwords.js';

/**
 * The server side of the draft editor (RC2-C).
 *
 * The editor mutates a draft entity by entity rather than recreating it, so
 * these tests are about what each mutation is allowed to do: which fields
 * may change, which are refused once the event leaves `draft`, and which
 * structural changes are refused while a device is paired to the door being
 * edited.
 */

describe('Draft editor — event, spaces and checkpoints', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let cookie: string;
  let csrf: string;

  beforeEach(async () => {
    const env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATA_DIR: './tests/scratch-draft-editor' });
    const conn = createDatabase(':memory:');
    sqlite = conn.sqlite;
    await runMigrations(sqlite);
    app = await buildApp({ env, dbConnection: conn });

    const now = Date.now();
    await conn.db.insert(staffUsers).values({
      id: crypto.randomUUID(),
      username: 'admin',
      usernameNormalized: 'admin',
      role: 'admin',
      passwordHash: await hashPassword('MotDePasse!2026'),
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'MotDePasse!2026' },
    });
    const setCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    csrf = login.json().csrfToken as string;
  });

  afterEach(async () => {
    await app.close();
  });

  function auth() {
    return { cookie, 'x-csrf-token': csrf };
  }

  /** A draft with Extérieur, Site and one door between them. */
  async function createDraft(overrides: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: auth(),
      payload: {
        event: { name: 'Festival', capacity: 2000, timezone: 'Europe/Paris', ...overrides },
        spaces: [
          { clientId: 'ext', name: 'Extérieur', kind: 'external', sortOrder: 0 },
          { clientId: 'site', name: 'Site', kind: 'leaf', capacity: 2000, sortOrder: 1 },
        ],
        checkpoints: [
          {
            name: 'Porte principale',
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
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    return {
      eventId: body.event.id as string,
      externalId: (body.spaces as Array<{ id: string; kind: string }>).find((s) => s.kind === 'external')!.id,
      siteId: (body.spaces as Array<{ id: string; kind: string }>).find((s) => s.kind === 'leaf')!.id,
      checkpointId: (body.checkpoints as Array<{ id: string }>)[0].id,
    };
  }

  async function addSpace(eventId: string, name: string, capacity: number | null) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/spaces`,
      headers: auth(),
      payload: { name, kind: 'leaf', capacity, sortOrder: 2 },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  /** Pairs a real device session to a checkpoint, as the field would. */
  async function pairDevice(eventId: string, checkpointId: string): Promise<string> {
    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/device-invites`,
      headers: auth(),
      payload: { checkpointId, expiresInMinutes: 30 },
    });
    expect(invite.statusCode, invite.body).toBe(201);

    const paired = await app.inject({
      method: 'POST',
      url: '/api/v1/device/pair',
      payload: { token: invite.json().token, appVersion: '1.0.0' },
    });
    expect(paired.statusCode, paired.body).toBe(200);
    return paired.json().deviceSession.id as string;
  }

  describe('timezone', () => {
    it('persists a valid IANA zone exactly as chosen', async () => {
      const { eventId } = await createDraft({ timezone: 'Pacific/Auckland' });
      const read = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}`, headers: { cookie } });
      expect(read.json().timezone).toBe('Pacific/Auckland');
    });

    it('refuses an invalid zone at creation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/events/drafts',
        headers: auth(),
        payload: {
          event: { name: 'Festival', capacity: 100, timezone: 'Mars/Olympus_Mons' },
          spaces: [{ clientId: 'ext', name: 'Extérieur', kind: 'external', sortOrder: 0 }],
          checkpoints: [],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('refuses a fixed offset, which carries no daylight-saving rules', async () => {
      const { eventId } = await createDraft();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: auth(),
        payload: { timezone: '+02:00' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('changes the zone of a draft', async () => {
      const { eventId } = await createDraft();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: auth(),
        payload: { timezone: 'America/New_York' },
      });
      expect(res.statusCode, res.body).toBe(200);

      const read = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}`, headers: { cookie } });
      expect(read.json().timezone).toBe('America/New_York');
    });

    it('refuses to change the zone once the event is live', async () => {
      const { eventId } = await createDraft();
      const started = await app.inject({ method: 'POST', url: `/api/v1/events/${eventId}/start`, headers: auth() });
      expect(started.statusCode, started.body).toBe(200);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: auth(),
        payload: { timezone: 'America/New_York' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('TIMEZONE_LOCKED');

      const read = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}`, headers: { cookie } });
      expect(read.json().timezone, 'the stored zone is unchanged').toBe('Europe/Paris');
    });

    it('still allows other event edits while live, unchanged by the timezone rule', async () => {
      const { eventId } = await createDraft();
      await app.inject({ method: 'POST', url: `/api/v1/events/${eventId}/start`, headers: auth() });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: auth(),
        payload: { capacity: 2500 },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().capacity).toBe(2500);
    });

    it('accepts a no-op timezone on a live event rather than refusing the whole patch', async () => {
      const { eventId } = await createDraft();
      await app.inject({ method: 'POST', url: `/api/v1/events/${eventId}/start`, headers: auth() });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: auth(),
        payload: { timezone: 'Europe/Paris', capacity: 2100 },
      });
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  describe('checkpoint endpoints', () => {
    it('moves a door to different zones on a draft', async () => {
      const { eventId, checkpointId, siteId } = await createDraft();
      const vipId = await addSpace(eventId, 'VIP', 100);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
        payload: { spaceAId: siteId, spaceBId: vipId },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().spaceAId).toBe(siteId);
      expect(res.json().spaceBId).toBe(vipId);
    });

    it('refuses both endpoints being the same space, and leaves the door unchanged', async () => {
      const { eventId, checkpointId, siteId, externalId } = await createDraft();

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
        payload: { spaceAId: siteId, spaceBId: siteId },
      });
      expect(res.statusCode).toBe(400);

      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/events/${eventId}/checkpoints`,
        headers: { cookie },
      });
      const unchanged = (read.json() as Array<{ id: string; spaceAId: string; spaceBId: string }>).find(
        (c) => c.id === checkpointId
      )!;
      expect(unchanged.spaceAId).toBe(externalId);
      expect(unchanged.spaceBId).toBe(siteId);
    });

    it('refuses an endpoint belonging to another event', async () => {
      const { eventId, checkpointId } = await createDraft();
      const other = await createDraft();

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
        payload: { spaceBId: other.siteId },
      });
      expect(res.statusCode).toBe(400);
    });

    it('refuses disabling both directions', async () => {
      const { eventId, checkpointId } = await createDraft();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
        payload: { allowAToB: false, allowBToA: false },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('paired-device safety', () => {
    it('refuses to move the endpoints of a door a device is paired to', async () => {
      const { eventId, checkpointId, siteId } = await createDraft();
      const vipId = await addSpace(eventId, 'VIP', 100);
      const deviceSessionId = await pairDevice(eventId, checkpointId);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
        payload: { spaceAId: siteId, spaceBId: vipId },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CHECKPOINT_IN_USE');

      // Nothing partially applied: the door still connects what the paired
      // device believes it connects.
      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/events/${eventId}/checkpoints`,
        headers: { cookie },
      });
      const cp = (read.json() as Array<{ id: string; spaceBId: string }>).find((c) => c.id === checkpointId)!;
      expect(cp.spaceBId).toBe(siteId);
      expect(deviceSessionId).toBeTruthy();
    });

    it('refuses to delete a door a device is paired to', async () => {
      const { eventId, checkpointId } = await createDraft();
      await pairDevice(eventId, checkpointId);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CHECKPOINT_IN_USE');

      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/events/${eventId}/checkpoints`,
        headers: { cookie },
      });
      expect(read.json()).toHaveLength(1);
    });

    it('allows the same structural edit once the device is revoked', async () => {
      const { eventId, checkpointId, siteId } = await createDraft();
      const vipId = await addSpace(eventId, 'VIP', 100);
      const deviceSessionId = await pairDevice(eventId, checkpointId);

      const revoked = await app.inject({
        method: 'POST',
        url: `/api/v1/device-sessions/${deviceSessionId}/revoke`,
        headers: auth(),
      });
      expect(revoked.statusCode, revoked.body).toBe(200);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
        payload: { spaceAId: siteId, spaceBId: vipId },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().spaceBId).toBe(vipId);
    });

    it('deletes a door whose only devices are revoked, taking its invitations with it', async () => {
      const { eventId, checkpointId } = await createDraft();
      const deviceSessionId = await pairDevice(eventId, checkpointId);
      await app.inject({
        method: 'POST',
        url: `/api/v1/device-sessions/${deviceSessionId}/revoke`,
        headers: auth(),
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
      });
      expect(res.statusCode, res.body).toBe(200);

      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/events/${eventId}/checkpoints`,
        headers: { cookie },
      });
      expect(read.json()).toHaveLength(0);
    });

    it('leaves a paired device’s own configuration untouched by a refused edit', async () => {
      const { eventId, checkpointId, siteId, externalId } = await createDraft();
      const vipId = await addSpace(eventId, 'VIP', 100);

      const invite = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${eventId}/device-invites`,
        headers: auth(),
        payload: { checkpointId, expiresInMinutes: 30 },
      });
      const paired = await app.inject({
        method: 'POST',
        url: '/api/v1/device/pair',
        payload: { token: invite.json().token, appVersion: '1.0.0' },
      });
      const deviceCookies = (paired.headers['set-cookie'] as string[] | string);
      const deviceCookie = (Array.isArray(deviceCookies) ? deviceCookies : [deviceCookies])
        .map((c) => c.split(';')[0])
        .join('; ');

      await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
        payload: { spaceAId: siteId, spaceBId: vipId },
      });

      const bootstrap = await app.inject({
        method: 'GET',
        url: '/api/v1/device/bootstrap',
        headers: { cookie: deviceCookie },
      });
      expect(bootstrap.statusCode, bootstrap.body).toBe(200);
      expect(bootstrap.json().checkpoint.spaceAId).toBe(externalId);
      expect(bootstrap.json().checkpoint.spaceBId).toBe(siteId);
    });
  });

  describe('space dependency and the external sentinel', () => {
    it('refuses to delete a space a door still references, leaving topology intact', async () => {
      const { eventId, siteId } = await createDraft();

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/events/${eventId}/spaces/${siteId}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('SPACE_IN_USE');

      const read = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/spaces`, headers: { cookie } });
      expect((read.json() as unknown[]).length).toBe(2);
    });

    it('deletes an unreferenced operational space', async () => {
      const { eventId } = await createDraft();
      const vipId = await addSpace(eventId, 'VIP', 100);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/events/${eventId}/spaces/${vipId}`,
        headers: auth(),
      });
      expect(res.statusCode, res.body).toBe(200);
    });

    it('refuses to delete the external sentinel while a door crosses it', async () => {
      const { eventId, externalId } = await createDraft();
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/events/${eventId}/spaces/${externalId}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('SPACE_IN_USE');
    });
  });

  describe('the draft-only lock', () => {
    it('refuses every topology mutation once the event is live', async () => {
      const { eventId, siteId, checkpointId } = await createDraft();
      await app.inject({ method: 'POST', url: `/api/v1/events/${eventId}/start`, headers: auth() });

      const mutations = [
        { method: 'POST' as const, url: `/api/v1/events/${eventId}/spaces`, payload: { name: 'Tard', kind: 'leaf', capacity: 10 } },
        { method: 'PATCH' as const, url: `/api/v1/events/${eventId}/spaces/${siteId}`, payload: { name: 'Renommé' } },
        { method: 'DELETE' as const, url: `/api/v1/events/${eventId}/spaces/${siteId}`, payload: undefined },
        { method: 'PATCH' as const, url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`, payload: { name: 'Renommée' } },
        { method: 'DELETE' as const, url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`, payload: undefined },
      ];

      for (const mutation of mutations) {
        const res = await app.inject({
          method: mutation.method,
          url: mutation.url,
          headers: auth(),
          ...(mutation.payload ? { payload: mutation.payload } : {}),
        });
        expect(res.statusCode, `${mutation.method} ${mutation.url} -> ${res.body}`).toBe(409);
        expect(res.json().code).toBe('TOPOLOGY_LOCKED');
      }
    });
  });
});
