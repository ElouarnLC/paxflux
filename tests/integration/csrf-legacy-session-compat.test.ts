import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { staffUsers, staffSessions } from '../../apps/server/src/db/schema.js';
import { hashToken, deriveCsrfToken } from '../../apps/server/src/auth/csrf.js';
import { COOKIE_NAME_STAFF } from '@paxflux/shared';
import crypto from 'node:crypto';

/**
 * Before the CSRF derivation fix, createStaffSession() stored a csrfHash
 * computed from an independent random token, unrelated to the session's
 * tokenHash. This reproduces that exact legacy row shape directly (rather
 * than through createStaffSession, which now always produces the new
 * derived-token shape) to prove the compatibility path in
 * requireStaffAuth actually covers a real pre-upgrade session.
 */
describe('CSRF compatibility for legacy (pre-derivation) staff sessions', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];
  let env: ReturnType<typeof parseEnv>;

  beforeEach(async () => {
    env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: './tests/scratch-csrf-legacy-data',
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

  async function seedLegacySession() {
    const now = Date.now();
    const userId = crypto.randomUUID();

    await db.insert(staffUsers).values({
      id: userId,
      username: 'legacy_admin',
      usernameNormalized: 'legacy_admin',
      displayName: 'Legacy Admin',
      role: 'admin',
      passwordHash: 'unused-in-this-test',
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });

    const sessionId = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(sessionToken);

    // The pre-fix shape: csrfHash comes from a random token with no
    // relationship to tokenHash — exactly what generateCsrfToken() used to
    // produce, and what deriveCsrfToken() no longer matches.
    const legacyCsrfToken = crypto.randomBytes(32).toString('base64url');
    const legacyCsrfHash = hashToken(legacyCsrfToken);

    await db.insert(staffSessions).values({
      id: sessionId,
      userId,
      tokenHash,
      csrfHash: legacyCsrfHash,
      createdAtMs: now,
      lastSeenAtMs: now,
      expiresAtMs: now + 12 * 3600 * 1000,
      revokedAtMs: null,
    });

    return { sessionToken, tokenHash, legacyCsrfToken, cookieHeader: `${COOKIE_NAME_STAFF}=${sessionToken}` };
  }

  it('GET /api/v1/auth/session works for a legacy session and returns the new deterministic token', async () => {
    const { tokenHash, cookieHeader } = await seedLegacySession();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().csrfToken).toBe(deriveCsrfToken(tokenHash));
  });

  it('the deterministic token returned for a legacy session authorizes a mutation', async () => {
    const { tokenHash, cookieHeader } = await seedLegacySession();
    const derivedToken = deriveCsrfToken(tokenHash);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'x-csrf-token': derivedToken, cookie: cookieHeader },
      payload: { name: 'Legacy Session, New Token', capacity: 100 },
    });

    expect(res.statusCode).toBe(201);
  });

  it('the original legacy token remains valid during the compatibility window (an older open tab keeps working)', async () => {
    const { legacyCsrfToken, cookieHeader } = await seedLegacySession();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'x-csrf-token': legacyCsrfToken, cookie: cookieHeader },
      payload: { name: 'Legacy Session, Legacy Token', capacity: 100 },
    });

    expect(res.statusCode).toBe(201);
  });

  it('an arbitrary, unrelated token is still rejected for a legacy session', async () => {
    const { cookieHeader } = await seedLegacySession();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'x-csrf-token': crypto.randomBytes(32).toString('base64url'), cookie: cookieHeader },
      payload: { name: 'Should Not Be Created', capacity: 100 },
    });

    expect(res.statusCode).toBe(403);
  });
});
