import { test, expect } from '@playwright/test';
import { ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers.js';

async function loginAsAdmin(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

test('un échec réseau au bootstrap affiche un état d\'erreur avec Réessayer, pas une déconnexion', async ({ page }) => {
  await loginAsAdmin(page);

  let callCount = 0;
  await page.route('**/api/v1/auth/session', async (route) => {
    callCount++;
    if (callCount === 1) {
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });

  await page.reload();

  // A real 401 sends the user to /login; a network failure must not: the
  // session may still be perfectly valid, only the request failed.
  await expect(page.getByText(/connexion au serveur impossible/i)).toBeVisible();
  const retryButton = page.getByRole('button', { name: /réessayer/i });
  await expect(retryButton).toBeVisible();
  expect(page.url()).not.toContain('/login');

  await retryButton.click();

  // Once the (simulated) network recovers, retrying must land back in the
  // authenticated admin area without requiring a fresh login.
  await expect(page.getByRole('link', { name: /nouvel événement|créer un événement/i })).toBeVisible();
});

test('un 500 du serveur au bootstrap affiche un état d\'erreur, pas une déconnexion', async ({ page }) => {
  await loginAsAdmin(page);

  let callCount = 0;
  await page.route('**/api/v1/auth/session', async (route) => {
    callCount++;
    if (callCount === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Internal Server Error',
          status: 500,
          code: 'INTERNAL_ERROR',
          detail: 'Erreur interne simulée.',
        }),
      });
    } else {
      await route.continue();
    }
  });

  await page.reload();

  await expect(page.getByText(/connexion au serveur impossible/i)).toBeVisible();
  expect(page.url()).not.toContain('/login');

  await page.getByRole('button', { name: /réessayer/i }).click();
  await expect(page.getByRole('link', { name: /nouvel événement|créer un événement/i })).toBeVisible();
});
