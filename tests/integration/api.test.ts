import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { instanceSettings, staffUsers } from '../../apps/server/src/db/schema.js';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

describe('Fastify REST API & Security Flow', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];
  let env: ReturnType<typeof parseEnv>;

  beforeEach(async () => {
    env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: './tests/scratch-api-data',
      BACKUP_DIR: './tests/scratch-api-backups',
    });
    const dbConn = createDatabase(':memory:');
    sqlite = dbConn.sqlite;
    db = dbConn.db;
    app = await buildApp({ env, dbConnection: dbConn });
  });

  afterEach(async () => {
    await app.close();
    sqlite.close();
  });

  it('GET /health/live and GET /health/ready return 200 OK', async () => {
    const resLive = await app.inject({ method: 'GET', url: '/health/live' });
    expect(resLive.statusCode).toBe(200);
    expect(resLive.json().status).toBe('ok');

    const resReady = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(resReady.statusCode).toBe(200);
    expect(resReady.json().status).toBe('ready');
  });

  it('Complete Setup -> Login -> Create Event -> Start Live flow', async () => {
    // 1. Get Meta
    const metaRes = await app.inject({ method: 'GET', url: '/api/v1/meta' });
    expect(metaRes.statusCode).toBe(200);
    expect(metaRes.json().isInitialized).toBe(false);

    // Retrieve setup token from instanceSettings
    const settings = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).get();
    expect(settings?.setupTokenHash).toBeDefined();

    // Since we know the hash was generated, we can simulate an admin directly or verify setup flow with correct token
    // Let's create an admin setup token directly for test
    const rawSetupToken = 'test-valid-setup-token-1234567890abcdef';
    const setupTokenHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
    await db
      .update(instanceSettings)
      .set({ setupTokenHash, setupTokenExpiresAtMs: Date.now() + 3600000 })
      .where(eq(instanceSettings.id, 1));

    // 2. Perform /setup
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: {
        setupToken: rawSetupToken,
        username: 'festival_admin',
        password: 'AdminPassword123!',
        instanceName: 'PaxFlux Fest',
      },
    });

    expect(setupRes.statusCode).toBe(201);
    const adminData = setupRes.json();
    expect(adminData.user.username).toBe('festival_admin');
    expect(adminData.csrfToken).toBeDefined();

    const cookies = setupRes.cookies;
    expect(cookies.length).toBeGreaterThan(0);
    const sessionCookie = cookies[0];

    // 3. Subsequent /setup must be rejected (SETUP_ALREADY_COMPLETED)
    const secondSetup = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: {
        setupToken: rawSetupToken,
        username: 'intruder',
        password: 'Password123!',
      },
    });
    expect(secondSetup.statusCode).toBe(409);

    // 4. Create Event as authenticated admin
    const createEventRes = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: {
        'x-csrf-token': adminData.csrfToken,
        cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      },
      payload: {
        name: 'Campulsations 2026',
        capacity: 1500,
        warningRatio1: 0.8,
        warningRatio2: 0.9,
      },
    });

    expect(createEventRes.statusCode).toBe(201);
    const eventObj = createEventRes.json();
    expect(eventObj.name).toBe('Campulsations 2026');
    expect(eventObj.status).toBe('draft');

    // 5. Create Checkpoint
    const spacesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${eventObj.id}/spaces`,
      headers: {
        cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      },
    });
    const spacesList = spacesRes.json();
    const extSpace = spacesList.find((s: any) => s.kind === 'external');
    const siteSpace = spacesList.find((s: any) => s.kind === 'leaf');

    const cpRes = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventObj.id}/checkpoints`,
      headers: {
        'x-csrf-token': adminData.csrfToken,
        cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      },
      payload: {
        name: 'Porte Principale',
        spaceAId: extSpace.id,
        spaceBId: siteSpace.id,
        allowAToB: true,
        allowBToA: true,
        labelAToB: 'Entrée +1',
        labelBToA: 'Sortie -1',
      },
    });
    expect(cpRes.statusCode).toBe(201);

    // 6. Start Event (draft -> live)
    const startRes = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventObj.id}/start`,
      headers: {
        'x-csrf-token': adminData.csrfToken,
        cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      },
    });
    expect(startRes.statusCode).toBe(200);
    expect(startRes.json().status).toBe('live');
  });
});
