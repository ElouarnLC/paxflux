import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import {
  staffUsers,
  events,
  spaces,
  checkpoints,
  deviceSessions,
  spaceState,
} from '../../apps/server/src/db/schema.js';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

describe('Counting API & Offline Batch Synchronization', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];
  let env: ReturnType<typeof parseEnv>;

  const adminId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const checkpointId = crypto.randomUUID();
  const externalSpaceId = crypto.randomUUID();
  const siteSpaceId = crypto.randomUUID();

  const deviceSessionId = crypto.randomUUID();
  const rawDeviceToken = 'test-device-session-token-32-chars-long';
  const tokenHash = crypto.createHash('sha256').update(rawDeviceToken).digest('hex');

  beforeEach(async () => {
    env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: './tests/scratch-counting-data',
    });
    const dbConn = createDatabase(':memory:');
    sqlite = dbConn.sqlite;
    db = dbConn.db;
    app = await buildApp({ env, dbConnection: dbConn });

    const now = Date.now();

    // 1. Seed Admin
    await db.insert(staffUsers).values({
      id: adminId,
      username: 'admin',
      usernameNormalized: 'admin',
      role: 'admin',
      passwordHash: 'hash',
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // 2. Seed Live Event
    await db.insert(events).values({
      id: eventId,
      name: 'Festival Live',
      slug: 'festival-live',
      capacity: 500,
      status: 'live',
      version: 1,
      createdBy: adminId,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // 3. Seed Spaces
    await db.insert(spaces).values([
      {
        id: externalSpaceId,
        eventId,
        name: 'Extérieur',
        kind: 'external',
        sortOrder: 0,
        createdAtMs: now,
        updatedAtMs: now,
      },
      {
        id: siteSpaceId,
        eventId,
        name: 'Site',
        kind: 'leaf',
        capacity: 500,
        sortOrder: 1,
        createdAtMs: now,
        updatedAtMs: now,
      },
    ]);

    await db.insert(spaceState).values({
      eventId,
      spaceId: siteSpaceId,
      occupancy: 0,
      updatedAtMs: now,
    });

    // 4. Seed Checkpoint
    await db.insert(checkpoints).values({
      id: checkpointId,
      eventId,
      name: 'Porte Sud',
      spaceAId: externalSpaceId,
      spaceBId: siteSpaceId,
      allowAToB: true,
      allowBToA: true,
      labelAToB: 'Entrée',
      labelBToA: 'Sortie',
      createdAtMs: now,
      updatedAtMs: now,
    });

    // 5. Seed Device Session
    await db.insert(deviceSessions).values({
      id: deviceSessionId,
      eventId,
      checkpointId,
      label: 'Porte Sud — appareil 1',
      tokenHash,
      createdAtMs: now,
      expiresAtMs: now + 3600000,
      revokedAtMs: null,
      lastSeenAtMs: now,
      lastPendingCount: 0,
    });
  });

  afterEach(async () => {
    await app.close();
    sqlite.close();
  });

  it('Applies offline batch of 5 counts atomically and updates compact state', async () => {
    const actions = Array.from({ length: 5 }).map((_, i) => ({
      clientActionId: crypto.randomUUID(),
      sequence: i + 1,
      type: 'count' as const,
      direction: 'a_to_b' as const,
      clientCreatedAtMs: Date.now() - 5000 + i * 1000,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/device/actions/batch',
      headers: {
        cookie: `paxflux_device_session=${rawDeviceToken}`,
      },
      payload: {
        actions,
        pendingCount: 0,
        appVersion: '1.0.0',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.acknowledged.length).toBe(5);
    expect(body.acknowledged.every((a: any) => a.status === 'applied')).toBe(true);
    expect(body.state.eventOccupancy).toBe(5);
  });

  it('Handles original count and reversal within the exact same batch payload with net zero effect', async () => {
    const originalActionId = crypto.randomUUID();
    const reversalActionId = crypto.randomUUID();

    const batch = [
      {
        clientActionId: originalActionId,
        sequence: 1,
        type: 'count' as const,
        direction: 'a_to_b' as const,
        clientCreatedAtMs: Date.now() - 2000,
      },
      {
        clientActionId: reversalActionId,
        sequence: 2,
        type: 'reversal' as const,
        targetClientActionId: originalActionId,
        clientCreatedAtMs: Date.now() - 1000,
      },
    ];

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/device/actions/batch',
      headers: {
        cookie: `paxflux_device_session=${rawDeviceToken}`,
      },
      payload: {
        actions: batch,
        pendingCount: 0,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.acknowledged.length).toBe(2);
    expect(body.acknowledged[0].status).toBe('applied');
    expect(body.acknowledged[1].status).toBe('applied');
    expect(body.state.eventOccupancy).toBe(0);
  });

  it('Batch is idempotent on repeat submissions', async () => {
    const action1 = {
      clientActionId: crypto.randomUUID(),
      sequence: 1,
      type: 'count' as const,
      direction: 'a_to_b' as const,
      clientCreatedAtMs: Date.now(),
    };

    // First send
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/device/actions/batch',
      headers: { cookie: `paxflux_device_session=${rawDeviceToken}` },
      payload: { actions: [action1] },
    });
    expect(res1.json().state.eventOccupancy).toBe(1);

    // Replay same batch 3 times
    for (let i = 0; i < 3; i++) {
      const resDup = await app.inject({
        method: 'POST',
        url: '/api/v1/device/actions/batch',
        headers: { cookie: `paxflux_device_session=${rawDeviceToken}` },
        payload: { actions: [action1] },
      });
      expect(resDup.json().acknowledged[0].status).toBe('applied');
      expect(resDup.json().state.eventOccupancy).toBe(1);
    }
  });
});
