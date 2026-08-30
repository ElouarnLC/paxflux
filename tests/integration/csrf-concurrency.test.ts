import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { instanceSettings } from '../../apps/server/src/db/schema.js';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

describe('CSRF token stability under concurrency', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];
  let env: ReturnType<typeof parseEnv>;

  beforeEach(async () => {
    env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: './tests/scratch-csrf-data',
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

  async function setupAdmin() {
    const rawSetupToken = 'test-valid-setup-token-1234567890abcdef';
    const setupTokenHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
    await db
      .update(instanceSettings)
      .set({ setupTokenHash, setupTokenExpiresAtMs: Date.now() + 3_600_000 })
      .where(eq(instanceSettings.id, 1));

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: {
        setupToken: rawSetupToken,
        username: 'festival_admin',
        password: 'AdminPassword123!',
      },
    });
    expect(setupRes.statusCode).toBe(201);
    const body = setupRes.json();
    const sessionCookie = setupRes.cookies[0];
    return { csrfToken: body.csrfToken as string, sessionCookie };
  }

  it('two concurrent GET /api/v1/auth/session calls for the same session return the same CSRF token', async () => {
    const { sessionCookie } = await setupAdmin();
    const cookieHeader = `${sessionCookie.name}=${sessionCookie.value}`;

    const [res1, res2] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: cookieHeader } }),
      app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: cookieHeader } }),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    const token1 = res1.json().csrfToken;
    const token2 = res2.json().csrfToken;

    expect(token1).toBeTruthy();
    expect(token1).toBe(token2);
  });

  it('a CSRF token from one concurrent /auth/session call still validates a mutation after the others resolve', async () => {
    const { sessionCookie } = await setupAdmin();
    const cookieHeader = `${sessionCookie.name}=${sessionCookie.value}`;

    // Simulate multiple tabs (or React StrictMode's double-invoke) all
    // hydrating the session concurrently on the same cookie.
    const sessionResponses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: cookieHeader } })
      )
    );
    const tokens = sessionResponses.map((r) => r.json().csrfToken);
    expect(new Set(tokens).size).toBe(1);

    // Any one of the returned tokens (here, the first) must still work for
    // a mutation performed after all the others resolved — nothing should
    // have rotated the token out from under a concurrent caller.
    const createEventRes = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: {
        'x-csrf-token': tokens[0],
        cookie: cookieHeader,
      },
      payload: { name: 'Concurrency Test Event', capacity: 100 },
    });

    expect(createEventRes.statusCode).toBe(201);
  });

  it('the CSRF token returned at login/setup remains valid after subsequent /auth/session calls', async () => {
    const { csrfToken: loginCsrfToken, sessionCookie } = await setupAdmin();
    const cookieHeader = `${sessionCookie.name}=${sessionCookie.value}`;

    // A second tab reloads and re-hydrates its own copy of the session.
    const sessionRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: cookieHeader },
    });
    expect(sessionRes.json().csrfToken).toBe(loginCsrfToken);

    // The first tab's original token (from setup/login, never re-fetched)
    // must still be accepted — it was never rotated away.
    const createEventRes = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: {
        'x-csrf-token': loginCsrfToken,
        cookie: cookieHeader,
      },
      payload: { name: 'Original Token Still Valid', capacity: 50 },
    });

    expect(createEventRes.statusCode).toBe(201);
  });
});
