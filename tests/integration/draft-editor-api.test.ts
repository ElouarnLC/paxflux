import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { staffUsers } from '../../apps/server/src/db/schema.js';
import { hashPassword } from '../../apps/server/src/auth/passwords.js';
import { withEventLock } from '../../apps/server/src/domain/event-lock.js';
import { markEventLiveSync } from '../../apps/server/src/domain/draft-topology.js';

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
  // -------------------------------------------------------------------------
  // Review round 1, blocker 1 — a stale editor must not mutate a live event
  // -------------------------------------------------------------------------

  describe('the draft precondition on the event itself', () => {
    it('refuses a stale editor’s save once the event has been started', async () => {
      // The field sequence: an admin opens the editor on a draft, someone
      // else starts the event, the editor never reloads and saves. Without
      // a server-side precondition this succeeds, because PATCH /events/:id
      // legitimately allows a live event's name and capacity to change.
      const { eventId } = await createDraft();
      await app.inject({ method: 'POST', url: `/api/v1/events/${eventId}/start`, headers: auth() });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: auth(),
        payload: { name: 'Renommé par un écran périmé', capacity: 999, expectedStatus: 'draft' },
      });

      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('EVENT_NO_LONGER_DRAFT');

      const after = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}`, headers: auth() });
      expect(after.json().name, 'nothing from the stale editor persisted').toBe('Festival');
      expect(after.json().capacity).toBe(2000);
    });

    it('leaves the supervision surface’s live capacity update working', async () => {
      // The precondition is opt-in, and only the editor sends it. The
      // generic route must keep doing what the dashboard needs.
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

    it('applies a draft-preconditioned save normally while the event is a draft', async () => {
      const { eventId } = await createDraft();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: auth(),
        payload: { name: 'Nom corrigé', capacity: 1234, expectedStatus: 'draft' },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().name).toBe('Nom corrigé');
      expect(res.json().capacity).toBe(1234);
      expect(res.json().status).toBe('draft');
    });
  });

  // -------------------------------------------------------------------------
  // Review round 1, blocker 2 — draft -> live is linearizable with edits
  // -------------------------------------------------------------------------

  describe('the draft → live boundary', () => {
    /**
     * The invariant, checked on the topology as it actually stands.
     *
     * A live event must satisfy the same rules `/start` validated. If a
     * mutation ever commits between that validation and the status flip,
     * this is what catches it: the event is live on a topology nobody
     * accepted, and the cheapest observable form of that is a topology that
     * would now fail the check outright.
     */
    async function assertLiveTopologyStillValid(eventId: string) {
      const event = (await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}`, headers: auth() })).json();
      if (event.status !== 'live') return;

      const spaces = (
        await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/spaces`, headers: auth() })
      ).json() as Array<{ id: string; kind: string; isActive: boolean }>;
      const checkpoints = (
        await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/checkpoints`, headers: auth() })
      ).json() as Array<{ spaceAId: string; spaceBId: string; isActive: boolean }>;

      const active = checkpoints.filter((c) => c.isActive);
      expect(spaces.some((s) => s.kind === 'external' && s.isActive), 'live event kept its boundary').toBe(true);
      expect(spaces.some((s) => s.kind === 'leaf' && s.isActive), 'live event kept an internal zone').toBe(true);
      expect(active.length, 'live event kept at least one door').toBeGreaterThan(0);

      const activeIds = new Set(spaces.filter((s) => s.isActive).map((s) => s.id));
      for (const cp of active) {
        expect(activeIds.has(cp.spaceAId), 'a live door lost an endpoint').toBe(true);
        expect(activeIds.has(cp.spaceBId), 'a live door lost an endpoint').toBe(true);
      }
    }

    // Both requests are issued before either is awaited, so they are
    // genuinely in flight together. Which one enters the critical section
    // first is not something a test can dictate — both handlers await
    // authentication before they get there — so what is asserted is the
    // invariant that must hold either way, over enough attempts to exercise
    // both orders.
    const ATTEMPTS = 12;

    it('a deletion racing start never leaves a live event without its door', async () => {
      // The sharpest shape available: deleting the only checkpoint makes the
      // topology invalid for live. If the deletion could commit between
      // `/start`'s validation and its status flip, the event would go live
      // with no door at all — which is exactly what validateEventForLive
      // exists to prevent, and what `assertLiveTopologyStillValid` detects.
      const seen = new Set<string>();

      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const { eventId, checkpointId } = await createDraft();

        const started = app.inject({ method: 'POST', url: `/api/v1/events/${eventId}/start`, headers: auth() });
        const deleted = app.inject({
          method: 'DELETE',
          url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
          headers: auth(),
        });
        const [startRes, deleteRes] = await Promise.all([started, deleted]);

        const checkpoints = (
          await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/checkpoints`, headers: auth() })
        ).json();

        if (deleteRes.statusCode === 200) {
          // The edit won: `/start` then validated a topology with no door
          // and refused it. A 200 here would be the blocker.
          seen.add('edit-first');
          expect(startRes.statusCode, `start accepted a doorless topology: ${startRes.body}`).toBe(400);
          expect(startRes.json().code).toBe('NO_ACTIVE_CHECKPOINTS');
          expect(checkpoints).toHaveLength(0);
        } else {
          // `/start` won: the edit is refused rather than committed past
          // the lock.
          seen.add('start-first');
          expect(deleteRes.statusCode, deleteRes.body).toBe(409);
          expect(deleteRes.json().code).toBe('TOPOLOGY_LOCKED');
          expect(startRes.statusCode, startRes.body).toBe(200);
          expect(checkpoints).toHaveLength(1);
        }

        await assertLiveTopologyStillValid(eventId);
      }

      expect(seen.size, 'at least one ordering was exercised').toBeGreaterThan(0);
    });

    it('an endpoint move racing start either goes live edited or is refused', async () => {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const { eventId, checkpointId, siteId } = await createDraft();
        const vipId = await addSpace(eventId, 'VIP', 80);

        const edited = app.inject({
          method: 'PATCH',
          url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
          headers: auth(),
          payload: { spaceBId: vipId },
        });
        const started = app.inject({ method: 'POST', url: `/api/v1/events/${eventId}/start`, headers: auth() });
        const [editRes, startRes] = await Promise.all([edited, started]);

        const stored = (
          await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/checkpoints`, headers: auth() })
        ).json()[0];

        if (editRes.statusCode === 200) {
          expect(stored.spaceBId, 'the accepted edit is the one that went live').toBe(vipId);
        } else {
          expect(editRes.statusCode, editRes.body).toBe(409);
          expect(editRes.json().code).toBe('TOPOLOGY_LOCKED');
          expect(stored.spaceBId, 'a refused edit changed nothing').toBe(siteId);
        }

        expect(startRes.statusCode, startRes.body).toBe(200);
        await assertLiveTopologyStillValid(eventId);
      }
    });

    it('excludes a mutation from the window a start holds across its backup', async () => {
      // The one interleaving the synchronous write transactions cannot close
      // on their own, pinned deterministically rather than raced for.
      //
      // `/start` is not one synchronous block and cannot be: it awaits a
      // `VACUUM INTO` backup between validating the topology and flipping
      // the status. This stands in for that shape exactly — read the
      // topology, await, then commit the flip — while the real DELETE route
      // runs against the same event. Without the lock the deletion lands
      // inside the await and the event goes live with no door; with it, the
      // deletion waits and is then refused.
      const { eventId, checkpointId } = await createDraft();

      let validatedDoorCount = 0;
      const startLike = withEventLock(eventId, async () => {
        validatedDoorCount = (
          sqlite.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE event_id = ?').get(eventId) as { n: number }
        ).n;
        // The window. Long enough that anything not excluded from it lands.
        await new Promise((resolve) => setTimeout(resolve, 60));
        return markEventLiveSync(sqlite, eventId, Date.now());
      });

      const deleted = app.inject({
        method: 'DELETE',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
      });

      const [wentLive, deleteRes] = await Promise.all([startLike, deleted]);

      expect(validatedDoorCount, 'the start validated a topology with its door').toBe(1);
      expect(wentLive).toBe(true);
      expect(deleteRes.statusCode, `the deletion entered the start's window: ${deleteRes.body}`).toBe(409);
      expect(deleteRes.json().code).toBe('TOPOLOGY_LOCKED');

      const remaining = (
        sqlite.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE event_id = ?').get(eventId) as { n: number }
      ).n;
      expect(remaining, 'the live topology is the one that was validated').toBe(validatedDoorCount);
      await assertLiveTopologyStillValid(eventId);
    });

    it('covers every draft-only mutation the editor uses, not just checkpoint PATCH', async () => {
      // Each of the six races its own `/start`. Whichever wins, the mutation
      // is either fully applied to a draft or refused with TOPOLOGY_LOCKED —
      // never applied to a live event.
      const mutations = [
        { method: 'POST' as const, path: 'spaces', payload: { name: 'Tardive', kind: 'leaf', capacity: 5 } },
        { method: 'PATCH' as const, path: 'spaces/:space', payload: { name: 'Renommée' } },
        { method: 'DELETE' as const, path: 'spaces/:vip', payload: undefined },
        { method: 'POST' as const, path: 'checkpoints', payload: null },
        { method: 'PATCH' as const, path: 'checkpoints/:cp', payload: { name: 'Renommée' } },
        { method: 'DELETE' as const, path: 'checkpoints/:cp', payload: undefined },
      ];

      for (const mutation of mutations) {
        const { eventId, checkpointId, externalId, siteId } = await createDraft();
        const vipId = await addSpace(eventId, 'VIP libre', 40);
        const url = `/api/v1/events/${eventId}/${mutation.path
          .replace(':space', siteId)
          .replace(':vip', vipId)
          .replace(':cp', checkpointId)}`;
        const payload =
          mutation.payload === null
            ? {
                name: 'Tardive',
                spaceAId: externalId,
                spaceBId: siteId,
                labelAToB: 'ENTRÉE +1',
                labelBToA: 'SORTIE −1',
              }
            : mutation.payload;

        const started = app.inject({ method: 'POST', url: `/api/v1/events/${eventId}/start`, headers: auth() });
        const mutated = app.inject({
          method: mutation.method,
          url,
          headers: auth(),
          ...(payload ? { payload } : {}),
        });
        const [startRes, mutateRes] = await Promise.all([started, mutated]);

        // Only two outcomes are legal, and both are checked rather than one
        // being assumed: applied to a draft, or refused.
        if (mutateRes.statusCode >= 400) {
          expect(mutateRes.statusCode, `${mutation.method} ${url} -> ${mutateRes.body}`).toBe(409);
          expect(mutateRes.json().code).toBe('TOPOLOGY_LOCKED');
          expect(startRes.statusCode, startRes.body).toBe(200);
        }

        await assertLiveTopologyStillValid(eventId);
      }
    });
  });
  // -------------------------------------------------------------------------
  // Review round 1, blocker 3 — pairing cannot slip into a structural edit
  // -------------------------------------------------------------------------

  describe('pairing against structural checkpoint edits', () => {
    /** Pairs, and hands back the cookie the phone would then bootstrap with. */
    function deviceCookie(res: { headers: Record<string, unknown> }): string {
      const raw = res.headers['set-cookie'];
      const list = Array.isArray(raw) ? raw : [raw as string];
      return list.map((c) => String(c).split(';')[0]).join('; ');
    }

    /** Everything a phone caches at bootstrap, as the phone would hold it. */
    async function bootstrapWith(cookie: string) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/device/bootstrap', headers: { cookie } });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().checkpoint as { spaceAId: string; spaceBId: string };
    }

    async function mintInvite(eventId: string, checkpointId: string): Promise<string> {
      const invite = await app.inject({
        method: 'POST',
        url: `/api/v1/events/${eventId}/device-invites`,
        headers: auth(),
        payload: { checkpointId, expiresInMinutes: 30 },
      });
      expect(invite.statusCode, invite.body).toBe(201);
      return invite.json().token as string;
    }

    it('never bootstraps a device on endpoints the server is about to change', async () => {
      // The window blocker 3 names: the edit checks for active sessions,
      // then awaits, then writes; a QR scan in that gap creates a session
      // that is later handed endpoints the server has already decided to
      // move — or, worse, is bootstrapped on the old ones.
      //
      // The check and the write are now one synchronous SQLite transaction,
      // and pairing runs its own (`auth/pairing.ts`), so the two cannot
      // interleave. Two consequences are asserted: whatever the device reads
      // is what the checkpoint actually says, and once its session exists
      // the endpoints are frozen against any further move.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const { eventId, checkpointId, siteId } = await createDraft();
        const vipId = await addSpace(eventId, 'VIP', 60);
        const token = await mintInvite(eventId, checkpointId);

        const pairing = app.inject({
          method: 'POST',
          url: '/api/v1/device/pair',
          payload: { token, appVersion: '1.0.0' },
        });
        const moving = app.inject({
          method: 'PATCH',
          url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
          headers: auth(),
          payload: { spaceBId: vipId },
        });
        const [pairRes, moveRes] = await Promise.all([pairing, moving]);
        expect(pairRes.statusCode, pairRes.body).toBe(200);

        const stored = (
          await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/checkpoints`, headers: auth() })
        ).json()[0];

        if (moveRes.statusCode === 200) {
          // The move committed before the session existed, so the device
          // has never seen anything but the new endpoints.
          expect(stored.spaceBId).toBe(vipId);
        } else {
          expect(moveRes.statusCode, moveRes.body).toBe(409);
          expect(moveRes.json().code).toBe('CHECKPOINT_IN_USE');
          expect(stored.spaceBId, 'a refused move changed nothing').toBe(siteId);
        }

        const cached = await bootstrapWith(deviceCookie(pairRes));
        expect(cached.spaceBId, 'the device cached what the checkpoint says').toBe(stored.spaceBId);

        // And now that the session is active and visible, the endpoints are
        // frozen: a second move is refused whichever way the race went.
        const second = await app.inject({
          method: 'PATCH',
          url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
          headers: auth(),
          payload: { spaceBId: stored.spaceBId === vipId ? siteId : vipId },
        });
        expect(second.statusCode, `endpoints were not frozen by the pairing: ${second.body}`).toBe(409);
        expect(second.json().code).toBe('CHECKPOINT_IN_USE');
      }
    });

    it('deletes only sessions proven revoked, and refuses while one is active', async () => {
      // Defence in depth for the deletion path. A blanket
      // `DELETE FROM device_sessions WHERE checkpoint_id = ?` would destroy
      // a live pairing on the strength of a count taken earlier in the same
      // request; the statement is narrowed to revoked rows so that an
      // unexpected active row cannot be swept away, and the foreign key then
      // refuses to orphan it.
      const { eventId, checkpointId } = await createDraft();

      const revokedSessionId = await pairDevice(eventId, checkpointId);
      await app.inject({
        method: 'POST',
        url: `/api/v1/device-sessions/${revokedSessionId}/revoke`,
        headers: auth(),
      });
      const activeSessionId = await pairDevice(eventId, checkpointId);

      const refused = await app.inject({
        method: 'DELETE',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe('CHECKPOINT_IN_USE');

      // The refusal rolled back: even the revoked row, which the deletion
      // would have been entitled to remove, is untouched.
      const rows = sqlite
        .prepare('SELECT id FROM device_sessions WHERE checkpoint_id = ?')
        .all(checkpointId) as Array<{ id: string }>;
      expect(rows.map((r) => r.id).sort()).toEqual([revokedSessionId, activeSessionId].sort());

      await app.inject({
        method: 'POST',
        url: `/api/v1/device-sessions/${activeSessionId}/revoke`,
        headers: auth(),
      });
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(
        sqlite.prepare('SELECT COUNT(*) AS n FROM device_sessions WHERE checkpoint_id = ?').get(checkpointId)
      ).toEqual({ n: 0 });
      expect(
        sqlite.prepare('SELECT COUNT(*) AS n FROM device_invites WHERE checkpoint_id = ?').get(checkpointId)
      ).toEqual({ n: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // Review round 1, item 4 — operational config under an active pairing
  // -------------------------------------------------------------------------

  describe('checkpoint configuration a paired counter has cached', () => {
    /**
     * Every field the phone stores and acts on. Endpoints decide what a tap
     * means; `allow*` decides which buttons exist; `label*` is what the
     * operator reads before pressing one. RC2-C refuses to change any of
     * them under a live pairing rather than migrating the device.
     */
    const forbidden: Array<[string, Record<string, unknown>]> = [
      ['un sens de passage fermé', { allowBToA: false }],
      ['un libellé réécrit', { labelAToB: 'ENTRÉE CONTRÔLÉE' }],
      ['une porte désactivée', { isActive: false }],
    ];

    for (const [what, payload] of forbidden) {
      it(`refuse ${what} tant qu’un appareil est appairé`, async () => {
        const { eventId, checkpointId } = await createDraft();
        const sessionId = await pairDevice(eventId, checkpointId);

        const refused = await app.inject({
          method: 'PATCH',
          url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
          headers: auth(),
          payload,
        });
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json().code).toBe('CHECKPOINT_IN_USE');

        const stored = (
          await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/checkpoints`, headers: auth() })
        ).json()[0];
        expect(stored.allowBToA).toBe(true);
        expect(stored.labelAToB).toBe('ENTRÉE +1');
        expect(stored.isActive).toBe(true);

        // Revoke and the same change is ordinary preparation again.
        await app.inject({
          method: 'POST',
          url: `/api/v1/device-sessions/${sessionId}/revoke`,
          headers: auth(),
        });
        const accepted = await app.inject({
          method: 'PATCH',
          url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
          headers: auth(),
          payload,
        });
        expect(accepted.statusCode, accepted.body).toBe(200);
      });
    }

    it('accepte une écriture sans changement, même appairée', async () => {
      // A no-op must not be refused merely for repeating what is stored:
      // the editor sends the whole checkpoint on every save, so a rename
      // would otherwise be impossible while a device is paired.
      const { eventId, checkpointId } = await createDraft();
      await pairDevice(eventId, checkpointId);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
        headers: auth(),
        payload: {
          name: 'Porte principale renommée',
          allowAToB: true,
          allowBToA: true,
          labelAToB: 'ENTRÉE +1',
          labelBToA: 'SORTIE −1',
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().name).toBe('Porte principale renommée');
    });
  });

  // -------------------------------------------------------------------------
  // Review round 1, item 5 — an event created before RC2-C stays editable
  // -------------------------------------------------------------------------

  describe('a legacy timezone the current validator would reject', () => {
    /** Seeds what the old 1–50 character column happily accepted. */
    async function legacyDraft(timezone: string) {
      const { eventId } = await createDraft();
      sqlite.prepare('UPDATE events SET timezone = ? WHERE id = ?').run(timezone, eventId);
      return eventId;
    }

    it('is loaded back exactly as stored', async () => {
      const eventId = await legacyDraft('GMT');
      const res = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}`, headers: auth() });
      expect(res.json().timezone).toBe('GMT');
    });

    it('does not block an unrelated edit that resends it unchanged', async () => {
      // The editor sends the whole event on every save. Rejecting the
      // unchanged legacy value would make the event permanently uneditable.
      const eventId = await legacyDraft('GMT');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: auth(),
        payload: { name: 'Nom corrigé', capacity: 1500, timezone: 'GMT', expectedStatus: 'draft' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().name).toBe('Nom corrigé');
      expect(res.json().timezone, 'the legacy value rode along untouched').toBe('GMT');
    });

    it('refuses a change to another invalid value', async () => {
      const eventId = await legacyDraft('GMT');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: auth(),
        payload: { timezone: '+05:00', expectedStatus: 'draft' },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');

      const after = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}`, headers: auth() });
      expect(after.json().timezone).toBe('GMT');
    });

    it('accepts a valid IANA replacement and persists it', async () => {
      const eventId = await legacyDraft('GMT');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: auth(),
        payload: { timezone: 'Europe/Lisbon', expectedStatus: 'draft' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().timezone).toBe('Europe/Lisbon');
    });

    it('keeps creation strict — nothing is grandfathered forward', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: auth(),
        payload: { name: 'Nouveau', capacity: 100, timezone: 'GMT' },
      });
      expect(res.statusCode, res.body).toBe(400);
    });
  });
  // -------------------------------------------------------------------------
  // Review round 1, item 7 — the editor is an admin surface, server-side too
  // -------------------------------------------------------------------------

  describe('who may edit a draft', () => {
    it('refuses every editor mutation to a supervisor', async () => {
      // The dashboard hides the entry point from a supervisor, and this is
      // the rule it is hiding: the server has always required admin for
      // these routes, so a half-working editor is all a supervisor could
      // ever have had.
      const now = Date.now();
      sqlite
        .prepare(
          `INSERT INTO staff_users (id, username, username_normalized, role, password_hash, is_active, created_at_ms, updated_at_ms)
           VALUES (?, 'superviseur', 'superviseur', 'supervisor', ?, 1, ?, ?)`
        )
        .run(crypto.randomUUID(), await hashPassword('MotDePasse!2026'), now, now);

      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'superviseur', password: 'MotDePasse!2026' },
      });
      expect(login.statusCode, login.body).toBe(200);
      const raw = login.headers['set-cookie'];
      const supervisorAuth = {
        cookie: (Array.isArray(raw) ? raw : [raw as string]).map((c) => String(c).split(';')[0]).join('; '),
        'x-csrf-token': login.json().csrfToken as string,
      };

      const { eventId, siteId, checkpointId } = await createDraft();

      const mutations = [
        { method: 'POST' as const, url: `/api/v1/events/${eventId}/spaces`, payload: { name: 'X', kind: 'leaf' } },
        { method: 'PATCH' as const, url: `/api/v1/events/${eventId}/spaces/${siteId}`, payload: { name: 'X' } },
        { method: 'DELETE' as const, url: `/api/v1/events/${eventId}/spaces/${siteId}`, payload: undefined },
        {
          method: 'PATCH' as const,
          url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`,
          payload: { name: 'X' },
        },
        { method: 'DELETE' as const, url: `/api/v1/events/${eventId}/checkpoints/${checkpointId}`, payload: undefined },
      ];

      for (const mutation of mutations) {
        const res = await app.inject({
          method: mutation.method,
          url: mutation.url,
          headers: supervisorAuth,
          ...(mutation.payload ? { payload: mutation.payload } : {}),
        });
        expect(res.statusCode, `${mutation.method} ${mutation.url} -> ${res.body}`).toBe(403);
      }
    });
  });
});
