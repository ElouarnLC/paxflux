import { test, expect } from '@playwright/test';
import { ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers.js';

test('une mutation admin fonctionne après un rechargement direct de /admin', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');

  // Simulate a bookmarked tab / hard refresh directly on /admin, without
  // passing back through the root route that currently hydrates the CSRF
  // token into memory.
  await page.reload();
  await page.waitForLoadState('networkidle');

  await page.getByRole('link', { name: /nouvel événement|créer un événement/i }).click();
  await page.waitForURL('**/admin/events/new');

  await page.locator('input[type="text"]').first().fill('Repro CSRF Reload');
  await page.locator('input[type="number"]').first().fill('20');
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('button', { name: /Valider et Lancer/i }).click();
  await page.waitForTimeout(500);

  // Today this mutation fails with a 403 INVALID_CSRF: the CSRF token
  // lives only in an in-memory JS variable, wiped by the reload and never
  // re-fetched outside of the `/` bootstrap route (no global AuthProvider).
  // The wizard surfaces the server's exact detail message in that case
  // ("Le token CSRF est manquant ou invalide."), not the generic fallback.
  await expect(page.getByText(/token CSRF|Erreur lors de la création/i)).not.toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
});
