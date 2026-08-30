import { test, expect } from '@playwright/test';
import { ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers.js';

test('une mutation admin fonctionne après un rechargement direct de /admin', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');

  // Simulate a bookmarked tab / hard refresh directly on /admin. The
  // in-memory CSRF token is wiped by the reload; AuthProvider must
  // re-hydrate it via GET /api/v1/auth/session before any admin route
  // under it renders.
  await page.reload();
  await page.waitForLoadState('networkidle');

  await page.getByRole('link', { name: /nouvel événement|créer un événement/i }).click();
  await page.waitForURL('**/admin/events/new');

  await page.locator('input[type="text"]').first().fill('Repro CSRF Reload');
  await page.locator('input[type="number"]').first().fill('20');
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('button', { name: /Créer l'événement/i }).click();
  await page.waitForTimeout(500);

  // Without a working AuthProvider, this mutation fails with a 403
  // INVALID_CSRF ("Le token CSRF est manquant ou invalide.") because the
  // reload wipes the in-memory CSRF token and nothing re-fetches it
  // outside of the `/` bootstrap route.
  await expect(page.getByText(/token CSRF|Erreur lors de la création/i)).not.toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
});
