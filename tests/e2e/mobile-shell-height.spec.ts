import { test, expect, Page } from '@playwright/test';
import { ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers.js';
import {
  assertScreenFitsViewport,
  assertShellFillsViewport,
  assertTouchTargets,
} from './responsive-helpers.js';

/**
 * The top-level height contract.
 *
 * #root establishes the dynamic viewport height once (`min-h-dvh`) and each
 * route claims it with `flex-1`. Nothing in the chain uses a percentage: a
 * route asking for `min-height: 100%` needs #root to have a definite height,
 * and #root must not have one — a long page has to be able to grow past the
 * viewport and scroll.
 *
 * The failure this file exists for is silent. A route that loses its height
 * does not overflow, does not throw and does not look obviously broken in a
 * screenshot: it collapses to its content, its background stops short of the
 * bottom of the screen, and the card it was centring rides high. So every
 * shell is measured, not eyeballed.
 */

async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

test('les écrans d’entrée remplissent le viewport et gardent leur centrage', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Connexion' })).toBeVisible();
  await assertShellFillsViewport(page, '/login', { expectsCentring: true });

  await page.goto('/setup');
  await expect(page.getByRole('button', { name: 'Créer le compte et démarrer' })).toBeVisible();
  await assertShellFillsViewport(page, '/setup', { expectsCentring: true });

  await page.goto('/pair');
  await expect(page.getByText('Erreur d’appairage')).toBeVisible();
  await assertShellFillsViewport(page, '/pair (sans token)', { expectsCentring: true });
});

test('l’état de chargement d’AuthProvider remplit le viewport', async ({ page }) => {
  await loginAsAdmin(page);

  // Hold the session bootstrap open so the loading shell — a lone spinner
  // that has nothing but its container to be centred by — can be measured.
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/auth/session', async (route) => {
    await held;
    await route.continue();
  });

  const navigation = page.goto('/admin');
  const spinner = page.locator('#root > * svg.animate-spin');
  await expect(spinner).toBeVisible();

  await assertShellFillsViewport(page, '/admin (AuthProvider chargement)', { expectsCentring: true });
  await assertScreenFitsViewport(page, '/admin (AuthProvider chargement)');

  release!();
  await navigation;
  await page.unroute('**/api/v1/auth/session');
});

test('l’état d’erreur d’AuthProvider remplit le viewport et reste utilisable au doigt', async ({ page }) => {
  await loginAsAdmin(page);

  // A network failure at bootstrap is not a logout: the session may still be
  // valid, so the operator gets an error card with a retry action. On a
  // phone that card is the whole screen, and Réessayer is the only way out.
  // The window is a flag, not a call count. `waitForURL('**/admin')`
  // resolves on the URL change, so the session request the previous page
  // fires can start either side of this route registration — counting calls
  // makes "the first one" mean different requests on a fast and a loaded
  // machine, and the reload's request then succeeds and no error state
  // appears at all. Failing every call inside the window is deterministic.
  let failSessionCalls = true;
  await page.route('**/api/v1/auth/session', async (route) => {
    if (failSessionCalls) {
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });

  await page.reload();
  await expect(page.getByText(/connexion au serveur impossible/i)).toBeVisible();

  await assertShellFillsViewport(page, '/admin (AuthProvider erreur)', { expectsCentring: true });
  await assertScreenFitsViewport(page, '/admin (AuthProvider erreur)');
  await assertTouchTargets(page, '/admin (AuthProvider erreur)');

  // And it still recovers, which is the point of the state existing.
  failSessionCalls = false;
  await page.getByRole('button', { name: /réessayer/i }).click();
  await expect(page.getByRole('link', { name: /nouvel événement|créer un événement/i })).toBeVisible();
});
