import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  AdminSession,
  createDeviceInviteToken,
  createDraftEventWithMainCheckpoint,
  getAdminSession,
  startEvent,
} from './helpers.js';
import { DB_NAME, waitForServiceWorkerControl } from './offline-helpers.js';

/**
 * RC2-D — where the application root sends this browser.
 *
 * The field failure: a phone paired at a door, added to the home screen and
 * reopened the next morning did not come back as a counter. `/` knew nothing
 * about local pairing, asked the server whether the instance was initialized
 * and sent an initialized one to `/admin` — which, having no staff session on
 * a handset, bounced it to a **staff login form**. Reproduced on the RC2-C
 * baseline before the fix; this is the regression that keeps it fixed.
 */

let session: AdminSession;

test.beforeAll(async () => {
  session = await getAdminSession();
});

async function pairThisBrowser(page: Page, name: string): Promise<{ eventId: string }> {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `${name} · ${test.info().project.name}`,
    capacity: 200,
  });
  await startEvent(session, topo.eventId);
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  await page.goto(`/pair#${token}`);
  // Pairing no longer navigates on a timer: the operator continues from the
  // completion step, which is also where they may name the handset.
  await page.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await page.waitForURL('**/counter');
  return { eventId: topo.eventId };
}

/**
 * Gets the service worker controlling this page, or reports that it could not.
 *
 * The platform's rule is that a worker takes control from the first
 * navigation *after* it activates — this project uses `registerType:
 * 'prompt'`, so there is no `clientsClaim`. A single reload issued straight
 * after pairing can therefore race activation and land before it, leaving
 * the page uncontrolled with no further navigation coming: that is exactly
 * how this failed on a loaded CI runner while passing locally.
 *
 * So activation is awaited first, and the navigation that claims control is
 * retried a bounded number of times. The assertion at the call site is
 * unchanged and still strict — this makes the *setup* deterministic rather
 * than making the test easier to satisfy.
 */
async function ensureServiceWorkerControls(page: Page, attempts = 3): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Resolves once a worker is activated for this scope. Without this the
    // reload below can precede registration entirely.
    const activated = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      try {
        await navigator.serviceWorker.ready;
        return true;
      } catch {
        return false;
      }
    });
    if (!activated) return false;

    // Short poll between attempts: control either arrives on the navigation
    // just made or needs another one, and waiting out a long timeout before
    // trying the thing that actually grants it wastes the whole budget.
    if (await waitForServiceWorkerControl(page, 3_000)) return true;

    // Activated but not yet in control: give it the navigation it needs.
    await page.reload();
  }
  return waitForServiceWorkerControl(page);
}

const currentPath = (page: Page) => new URL(page.url()).pathname;

test('un téléphone appairé rouvre sur son compteur, pas sur l’administration', async ({ page }) => {
  await pairThisBrowser(page, 'RC2D racine appairée');

  // What an installed application does on every launch.
  await page.goto('/');
  await page.waitForURL('**/counter');

  expect(currentPath(page)).toBe('/counter');
  // And it is really the counter, not a redirect that happens to land there.
  await expect(page.getByTestId('counter-device-label')).toBeVisible();
});

test('un téléphone appairé rouvre sur son compteur sans réseau', async ({ page, context }) => {
  // The critical case. An installed counter launched in a dead spot must
  // reach its counter from its own service worker and IndexedDB, with no
  // `/meta` request to depend on.
  await pairThisBrowser(page, 'RC2D racine hors ligne');

  const controlled = await ensureServiceWorkerControls(page);
  expect(controlled, 'the service worker must control the page before going offline').toBe(true);

  await context.setOffline(true);
  try {
    await page.goto('/');
    await page.waitForURL('**/counter', { timeout: 20_000 });

    expect(currentPath(page)).toBe('/counter');
    // The shell opened from local state: the event and door it was paired to
    // are on screen with nothing reachable to have fetched them from.
    await expect(page.getByTestId('counter-device-label')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test('un appairage dont la configuration manque reste un compteur', async ({ page }) => {
  // `beginPairingHandoff` records `pendingSessionId` the instant
  // `/device/pair` succeeds. CounterView has a fail-closed screen for it;
  // the root route must lead there rather than to admin or setup.
  await pairThisBrowser(page, 'RC2D configuration en attente');

  await page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const existing = await new Promise<any>((resolve, reject) => {
      const req = db.transaction('device_config', 'readonly').objectStore('device_config').get('current');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('device_config', 'readwrite');
      // Exactly what a handoff leaves behind: an identity, no configuration.
      tx.objectStore('device_config').put({
        key: 'current',
        pendingSessionId: existing?.bootstrap?.deviceSession?.id ?? 'pending-session',
        updatedAtMs: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, DB_NAME);

  await page.goto('/');
  await page.waitForURL('**/counter');
  expect(currentPath(page)).toBe('/counter');
  await expect(page.getByText(/configuration/i).first()).toBeVisible();
});

test('un navigateur sans appareil va à l’administration sur une instance initialisée', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL(/\/(admin|login)/);
  // The instance is initialized and this browser has no device identity, so
  // the root sends it to the staff surface. Whether that surface then asks
  // for a login is AuthProvider's business, not the root route's.
  expect(['/admin', '/login']).toContain(currentPath(page));
});

test('un serveur injoignable n’est pas lu comme une instance non initialisée', async ({ page }) => {
  // The second field defect: a failed `/meta` left the response null and
  // `!meta?.isInitialized` routed to `/setup`, offering to create a first
  // administrator on an instance that already had one.
  await page.route('**/api/v1/meta', (route) => route.abort('failed'));

  await page.goto('/');
  await expect(page.getByTestId('root-server-unavailable')).toBeVisible();
  expect(currentPath(page), 'never /setup on silence').toBe('/');

  // And it recovers on its own terms once the server answers again.
  await page.unroute('**/api/v1/meta');
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await page.waitForURL(/\/(admin|login)/);
});

test('l’accès direct à /admin n’est pas détourné par la logique appareil', async ({ page }) => {
  await pairThisBrowser(page, 'RC2D admin direct');

  // A paired browser asking for the admin surface gets the admin surface.
  // Root device routing decides what `/` means, not what every URL means.
  await page.goto('/admin');
  await page.waitForURL(/\/(admin|login)/);
  expect(currentPath(page)).not.toBe('/counter');
});

test('l’accès direct à /counter reste direct', async ({ page }) => {
  await pairThisBrowser(page, 'RC2D counter direct');
  await page.goto('/counter');
  expect(currentPath(page)).toBe('/counter');
});

test('le manifeste de production déclare son contrat de lancement', async () => {
  // Built by `pretest:e2e`, so this reads what a deployment actually ships
  // rather than what the Vite config intends.
  const manifestPath = path.resolve(process.cwd(), 'apps/web/dist/manifest.webmanifest');
  expect(fs.existsSync(manifestPath), `${manifestPath} should exist after a build`).toBe(true);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  expect(manifest.id).toBe('/');
  expect(manifest.start_url).toBe('/');
  expect(manifest.scope).toBe('/');
  expect(manifest.display).toBe('standalone');

  // `/counter` would be wrong: one application serves staff browsers and
  // paired handsets, and which one this browser is belongs to the root
  // router, which reads local pairing state a manifest cannot see.
  expect(manifest.start_url).not.toContain('counter');
  // And nothing secret or per-device may travel in a file every installed
  // copy carries.
  for (const field of [manifest.id, manifest.start_url, manifest.scope]) {
    expect(String(field)).not.toMatch(/token|session|event|checkpoint|#/i);
  }
});
