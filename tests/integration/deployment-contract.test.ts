import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import { parseEnv, Env } from '../../apps/server/src/config/env.js';
import { resolvePairingBaseUrl } from '../../apps/server/src/auth/pairing.js';

/**
 * Deployment-contract tests (Phase 10 §6, §7).
 *
 * What an operator gets wrong on the day is rarely the counting logic: it is
 * a QR code that encodes an address no phone can open, or a static file server
 * that hands out something it should not. Both are contracts the product must
 * honour before it can be installed by someone who is not its author, and
 * neither needs a real public domain to prove.
 */

function envWith(overrides: Record<string, string | undefined>): Env {
  return parseEnv({ NODE_ENV: 'test', DATA_DIR: './data', BACKUP_DIR: './backups', ...overrides });
}

describe('§7A — PUBLIC_BASE_URL is set: the pairing URL is absolute and canonical', () => {
  it('uses the configured origin verbatim, whatever origin the admin browses from', () => {
    const env = envWith({ PUBLIC_BASE_URL: 'https://counter.yourfestival.org' });

    // The admin is on an SSH tunnel; the phones are not. The server, not the
    // browser, decides.
    const resolved = resolvePairingBaseUrl(env, { protocol: 'http', host: '127.0.0.1:3000' });

    expect('error' in resolved).toBe(false);
    if ('error' in resolved) return;
    expect(resolved.baseUrl).toBe('https://counter.yourfestival.org');
    expect(resolved.source).toBe('public_base_url');
    expect(resolved.unreachableFromPhone).toBe(false);
  });

  it('normalises a trailing slash instead of emitting a double slash', () => {
    for (const configured of [
      'https://counter.yourfestival.org/',
      'https://counter.yourfestival.org///',
    ]) {
      const resolved = resolvePairingBaseUrl(envWith({ PUBLIC_BASE_URL: configured }), null);
      expect('error' in resolved).toBe(false);
      if ('error' in resolved) return;
      expect(resolved.baseUrl).toBe('https://counter.yourfestival.org');
      // The URL a phone actually receives, built the way createDeviceInvite builds it.
      expect(`${resolved.baseUrl}/pair#deadbeef`).toBe(
        'https://counter.yourfestival.org/pair#deadbeef'
      );
    }
  });

  it('never injects the request loopback address into a configured public URL', () => {
    const resolved = resolvePairingBaseUrl(
      envWith({ PUBLIC_BASE_URL: 'https://counter.yourfestival.org' }),
      { protocol: 'http', host: 'localhost:3000' }
    );
    if ('error' in resolved) throw new Error('expected a resolved base URL');
    expect(resolved.baseUrl).not.toMatch(/localhost|127\.0\.0\.1|\[?::1\]?/);
  });

  it('still warns when the configured URL is itself a loopback copy-paste', () => {
    // Being configured does not make it reachable. `http://localhost:3000` is
    // the most common wrong value and produces a QR no handset can open.
    for (const configured of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      const resolved = resolvePairingBaseUrl(envWith({ PUBLIC_BASE_URL: configured }), null);
      if ('error' in resolved) throw new Error('expected a resolved base URL');
      expect(resolved.baseUrl).toBe(configured);
      expect(resolved.unreachableFromPhone).toBe(true);
    }
  });
});

describe('§7B — PUBLIC_BASE_URL is absent: documented fallback, never a silently wrong link', () => {
  it('falls back to the request origin, which is right for the common LAN case', () => {
    const resolved = resolvePairingBaseUrl(envWith({}), { protocol: 'http', host: '192.168.1.24:3000' });
    if ('error' in resolved) throw new Error('expected a resolved base URL');
    expect(resolved.baseUrl).toBe('http://192.168.1.24:3000');
    expect(resolved.source).toBe('request_origin');
    // A LAN address is exactly what the phones can reach: no warning.
    expect(resolved.unreachableFromPhone).toBe(false);
  });

  it('flags a loopback request origin rather than emitting an unusable QR silently', () => {
    for (const host of ['localhost:3000', '127.0.0.1:3000', '0.0.0.0:3000', '[::1]:3000']) {
      const resolved = resolvePairingBaseUrl(envWith({}), { protocol: 'http', host });
      if ('error' in resolved) throw new Error(`expected a resolved base URL for ${host}`);
      expect(resolved.source).toBe('request_origin');
      expect(resolved.unreachableFromPhone, `${host} is not reachable from a handset`).toBe(true);
    }
  });

  it('refuses outright when there is no origin to fall back to', () => {
    // Better an explicit refusal the admin can act on than a QR encoding a
    // bare "/pair#token" that resolves to nothing once scanned.
    expect(resolvePairingBaseUrl(envWith({}), null)).toEqual({ error: 'NO_PUBLIC_BASE_URL' });
    expect(resolvePairingBaseUrl(envWith({}), { protocol: 'http', host: '' })).toEqual({
      error: 'NO_PUBLIC_BASE_URL',
    });
  });
});

describe('§6 — the static file server hands out the frontend and nothing else', () => {
  /**
   * The server serves apps/web/dist for every non-API route. @fastify/static
   * 8.x carried a HIGH route-guard bypass via path traversal
   * (GHSA-83w8-p2f5-377r) and an authorization bypass via non-canonical URL
   * paths (GHSA-8pvw-jcv7-9cmj); Phase 10 upgraded to 10.1.3. What matters to
   * an operator is not the version number but that nothing outside the built
   * frontend is reachable — the same volume holds /data/app.db and, on a fresh
   * install, /data/setup-token.txt.
   */
  const scratchDir = path.resolve(process.cwd(), 'tests/scratch-deployment-contract');
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    fs.mkdirSync(scratchDir, { recursive: true });
    const env = parseEnv({
      NODE_ENV: 'test',
      DATA_DIR: scratchDir,
      BACKUP_DIR: scratchDir,
      LOG_LEVEL: 'silent',
    });
    const conn = createDatabase(path.join(scratchDir, 'app.db'));
    runMigrations(conn.sqlite, path.join(scratchDir, 'app.db'));
    app = await buildApp({ env, dbConnection: conn });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  const hasBuiltFrontend = fs.existsSync(path.resolve(process.cwd(), 'apps/web/dist/index.html'));

  it.runIf(hasBuiltFrontend)('serves the SPA shell at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="root"');
  });

  /**
   * Every one of these is a way of spelling "give me a file above the static
   * root". None may return the content of a real file. The bar is deliberately
   * behavioural rather than status-code-exact: the SPA fallback legitimately
   * answers 200 with index.html for an unknown path, so what is asserted is
   * that the *body* is never anything but the frontend.
   */
  const TRAVERSALS = [
    '/../package.json',
    '/../../package.json',
    '/..%2fpackage.json',
    '/%2e%2e/package.json',
    '/%2e%2e%2fpackage.json',
    '/..%252fpackage.json',
    '/....//package.json',
    '/%2e%2e%5cpackage.json',
    '/..%c0%afpackage.json',
    '/assets/../../../package.json',
    '/assets/..%2f..%2f..%2fpackage.json',
  ];

  it.each(TRAVERSALS)('refuses to serve a file above the static root: %s', async (url) => {
    const res = await app.inject({ method: 'GET', url });

    // Whatever the status, the payload must never be the repository manifest.
    expect(res.body).not.toContain('"name": "paxflux"');
    expect(res.body).not.toContain('"@paxflux/server"');
    expect([200, 400, 403, 404]).toContain(res.statusCode);
    if (res.statusCode === 200 && hasBuiltFrontend) {
      // The only legitimate 200 here is the SPA fallback.
      expect(res.body).toContain('<div id="root"');
    }
  });

  it('does not expose the database or the setup token through the static route', async () => {
    // Simulate the real deployment shape, where DATA_DIR sits next to the app.
    fs.writeFileSync(path.join(scratchDir, 'setup-token.txt'), 'PAXFLUX SETUP TOKEN:\nsecret-value\n');

    for (const url of [
      '/setup-token.txt',
      '/data/setup-token.txt',
      '/../tests/scratch-deployment-contract/setup-token.txt',
      '/..%2ftests%2fscratch-deployment-contract%2fsetup-token.txt',
      '/app.db',
      '/data/app.db',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body, `${url} leaked a secret`).not.toContain('secret-value');
      expect(res.body, `${url} leaked the token file header`).not.toContain('PAXFLUX SETUP TOKEN');
    }
  });

  /**
   * The API error shape is part of the published contract and must not depend
   * on whether the frontend bundle happens to exist: before Phase 10 the
   * problem-details handler was registered only inside the
   * `if (apps/web/dist exists)` branch, so a dev server answered Fastify's
   * default `{statusCode, error, message}` for the very same route.
   */
  it('keeps API 404s as RFC 7807 problem details rather than the SPA shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
