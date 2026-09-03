import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { staffUsers } from '../../apps/server/src/db/schema.js';
import { hashPassword } from '../../apps/server/src/auth/passwords.js';
import { DEVICE_LABEL_MAX_LENGTH } from '@paxflux/shared';

/**
 * RC2-D — a device is a physical phone, and it has a name of its own.
 *
 * Two renames share one validated contract: staff renaming a handset from
 * the management table, and the handset renaming itself after pairing. What
 * these assert is that the self endpoint is genuinely *self* — that there is
 * no payload a device can send to reach another one — and that a label
 * changes a label and nothing else.
 */

describe('Device identity and renaming', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let cookie: string;
  let csrf: string;

  beforeEach(async () => {
    const env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATA_DIR: './tests/scratch-device-identity' });
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

  async function createLiveEvent() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: auth(),
      payload: {
        event: { name: 'Festival', capacity: 2000, timezone: 'Europe/Paris' },
        spaces: [
          { clientId: 'ext', name: 'Extérieur', kind: 'external', sortOrder: 0 },
          { clientId: 'site', name: 'Site', kind: 'leaf', capacity: 2000, sortOrder: 1 },
        ],
        checkpoints: [
          {
            name: 'Porte nord',
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
    const eventId = body.event.id as string;
    await app.inject({ method: 'POST', url: `/api/v1/events/${eventId}/start`, headers: auth() });
    return { eventId, checkpointId: body.checkpoints[0].id as string };
  }

  /** A real paired handset, with the cookie it would then use. */
  async function pairDevice(eventId: string, checkpointId: string) {
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

    const raw = paired.headers['set-cookie'];
    return {
      id: paired.json().deviceSession.id as string,
      label: paired.json().deviceSession.label as string,
      cookie: (Array.isArray(raw) ? raw : [raw as string]).map((c) => String(c).split(';')[0]).join('; '),
    };
  }

  function storedLabel(sessionId: string): string | undefined {
    const row = sqlite.prepare('SELECT label FROM device_sessions WHERE id = ?').get(sessionId) as
      | { label: string }
      | undefined;
    return row?.label;
  }

  // -------------------------------------------------------------------------

  it('gives a paired phone a usable default name derived from its door', async () => {
    const { eventId, checkpointId } = await createLiveEvent();
    const device = await pairDevice(eventId, checkpointId);

    expect(device.label).toBe('Porte nord — appareil 1');
    // And the generated name is short enough to be saved back, which is the
    // constraint that sets DEVICE_LABEL_MAX_LENGTH.
    expect(device.label.length).toBeLessThanOrEqual(DEVICE_LABEL_MAX_LENGTH);
  });

  it('renames itself without changing anything else about the pairing', async () => {
    const { eventId, checkpointId } = await createLiveEvent();
    const device = await pairDevice(eventId, checkpointId);

    const before = sqlite.prepare('SELECT * FROM device_sessions WHERE id = ?').get(device.id) as Record<
      string,
      unknown
    >;

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/device/session',
      headers: { cookie: device.cookie },
      payload: { label: '  Téléphone entrée nord  ' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().deviceSession.id, 'same session').toBe(device.id);
    expect(res.json().deviceSession.label, 'trimmed by the shared schema').toBe('Téléphone entrée nord');

    const after = sqlite.prepare('SELECT * FROM device_sessions WHERE id = ?').get(device.id) as Record<
      string,
      unknown
    >;

    // Field by field: the label moved and nothing else did. This is the
    // assertion that would catch a future rename widening into an update of
    // whatever the client happened to send.
    for (const column of Object.keys(before)) {
      if (column === 'label') continue;
      expect(after[column], `column ${column} must not change on a rename`).toEqual(before[column]);
    }

    // What the phone reads back agrees.
    const bootstrap = await app.inject({
      method: 'GET',
      url: '/api/v1/device/bootstrap',
      headers: { cookie: device.cookie },
    });
    expect(bootstrap.json().deviceSession.label).toBe('Téléphone entrée nord');
    expect(bootstrap.json().checkpoint.id).toBe(checkpointId);
  });

  it('refuses an empty, blank or over-long name and keeps the previous one', async () => {
    const { eventId, checkpointId } = await createLiveEvent();
    const device = await pairDevice(eventId, checkpointId);

    for (const label of ['', '   ', 'x'.repeat(DEVICE_LABEL_MAX_LENGTH + 1)]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/device/session',
        headers: { cookie: device.cookie },
        payload: { label },
      });
      expect(res.statusCode, `label=${JSON.stringify(label)} -> ${res.body}`).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(storedLabel(device.id), 'the stored name is untouched').toBe(device.label);
    }
  });

  it('cannot rename another device, whatever the body claims', async () => {
    const { eventId, checkpointId } = await createLiveEvent();
    const deviceA = await pairDevice(eventId, checkpointId);
    const deviceB = await pairDevice(eventId, checkpointId);
    expect(deviceA.id).not.toBe(deviceB.id);

    // Every shape a caller might reach for. The endpoint is singular and
    // takes identity from the cookie, so none of these has anywhere to go.
    const crafted = [
      { label: 'Détourné', id: deviceB.id },
      { label: 'Détourné', deviceSessionId: deviceB.id },
      { label: 'Détourné', sessionId: deviceB.id },
      { label: 'Détourné', deviceSession: { id: deviceB.id } },
    ];

    for (const payload of crafted) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/device/session',
        headers: { cookie: deviceA.cookie },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(200);
      // A renames A. B is never touched.
      expect(res.json().deviceSession.id).toBe(deviceA.id);
      expect(storedLabel(deviceB.id), `B survived ${JSON.stringify(payload)}`).toBe(deviceB.label);
    }
  });

  it('refuses a revoked device and writes nothing', async () => {
    const { eventId, checkpointId } = await createLiveEvent();
    const device = await pairDevice(eventId, checkpointId);

    await app.inject({
      method: 'POST',
      url: `/api/v1/device-sessions/${device.id}/revoke`,
      headers: auth(),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/device/session',
      headers: { cookie: device.cookie },
      payload: { label: 'Après révocation' },
    });

    expect(res.statusCode, res.body).toBe(401);
    expect(storedLabel(device.id)).toBe(device.label);
  });

  it('refuses an unauthenticated rename', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/device/session',
      payload: { label: 'Sans session' },
    });
    expect(res.statusCode, res.body).toBe(401);
  });

  // -------------------------------------------------------------------------

  describe('staff rename', () => {
    it('renames an existing session and returns the canonical value', async () => {
      const { eventId, checkpointId } = await createLiveEvent();
      const device = await pairDevice(eventId, checkpointId);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/device-sessions/${device.id}`,
        headers: auth(),
        payload: { label: '  Téléphone régie  ' },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().deviceSession).toEqual({ id: device.id, label: 'Téléphone régie' });

      // Ownership is untouched: the device still belongs to its door.
      const row = sqlite.prepare('SELECT * FROM device_sessions WHERE id = ?').get(device.id) as Record<
        string,
        unknown
      >;
      expect(row.checkpoint_id).toBe(checkpointId);
      expect(row.event_id).toBe(eventId);

      // And the management list shows the canonical value.
      const devices = await app.inject({
        method: 'GET',
        url: `/api/v1/events/${eventId}/devices`,
        headers: auth(),
      });
      expect(devices.json()[0].label).toBe('Téléphone régie');
    });

    it('reports an unknown session rather than claiming success', async () => {
      // The previous implementation ran an UPDATE that matched nothing and
      // answered `{ success: true }`, telling the management table a rename
      // had happened when none had.
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/device-sessions/${crypto.randomUUID()}`,
        headers: auth(),
        payload: { label: 'Fantôme' },
      });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().code).toBe('DEVICE_NOT_FOUND');
    });

    it('applies the same validation as the device itself', async () => {
      const { eventId, checkpointId } = await createLiveEvent();
      const device = await pairDevice(eventId, checkpointId);

      for (const label of ['', '  ', 'x'.repeat(DEVICE_LABEL_MAX_LENGTH + 1)]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/v1/device-sessions/${device.id}`,
          headers: auth(),
          payload: { label },
        });
        expect(res.statusCode, `label=${JSON.stringify(label)}`).toBe(400);
        expect(storedLabel(device.id)).toBe(device.label);
      }
    });
  });

  // -------------------------------------------------------------------------

  describe('the heartbeat carries canonical identity', () => {
    it('brings back the name staff just set', async () => {
      // This is how an open counter learns about a rename without a second
      // polling loop: the beat already runs, already proves the session, and
      // already refuses to answer for one the cookie does not authenticate.
      const { eventId, checkpointId } = await createLiveEvent();
      const device = await pairDevice(eventId, checkpointId);

      await app.inject({
        method: 'PATCH',
        url: `/api/v1/device-sessions/${device.id}`,
        headers: auth(),
        payload: { label: 'Téléphone entrée nord' },
      });

      const beat = await app.inject({
        method: 'POST',
        url: '/api/v1/device/heartbeat',
        headers: { cookie: device.cookie },
        payload: { pendingCount: 0, expectedDeviceSessionId: device.id, appVersion: '1.0.0' },
      });

      expect(beat.statusCode, beat.body).toBe(200);
      expect(beat.json().deviceSession).toEqual({ id: device.id, label: 'Téléphone entrée nord' });
      expect(typeof beat.json().serverTimeMs).toBe('number');
    });

    it('still refuses a beat naming another session, and carries no label with the refusal', async () => {
      const { eventId, checkpointId } = await createLiveEvent();
      const deviceA = await pairDevice(eventId, checkpointId);
      const deviceB = await pairDevice(eventId, checkpointId);

      const beat = await app.inject({
        method: 'POST',
        url: '/api/v1/device/heartbeat',
        headers: { cookie: deviceA.cookie },
        payload: { pendingCount: 0, expectedDeviceSessionId: deviceB.id, appVersion: '1.0.0' },
      });

      expect(beat.statusCode).toBe(409);
      expect(beat.json().code).toBe('DEVICE_SESSION_MISMATCH');
      expect(beat.json().deviceSession, 'a refusal names nobody').toBeUndefined();
    });
  });
});
