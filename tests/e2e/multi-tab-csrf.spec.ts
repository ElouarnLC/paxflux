import { test, expect } from '@playwright/test';
import { ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers.js';

test('deux onglets partageant la même session peuvent recharger puis muter chacun', async ({ context }) => {
  const tab1 = await context.newPage();
  await tab1.goto('/login');
  await tab1.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await tab1.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await tab1.getByRole('button', { name: 'Connexion' }).click();
  await tab1.waitForURL('**/admin');

  // Same browser context = same session cookie, simulating a second tab
  // opened on the already-authenticated session.
  const tab2 = await context.newPage();
  await tab2.goto('/admin');
  await tab2.waitForLoadState('networkidle');

  // Both tabs reload directly on /admin — each must independently
  // re-hydrate its own CSRF token via GET /api/v1/auth/session. If that
  // endpoint rotated the token on every call (the old, racy behavior),
  // whichever tab hydrated last would silently invalidate the other's
  // already-hydrated token.
  await Promise.all([tab1.reload(), tab2.reload()]);
  await Promise.all([tab1.waitForLoadState('networkidle'), tab2.waitForLoadState('networkidle')]);

  async function createEventFrom(page: typeof tab1, name: string) {
    await page.getByRole('link', { name: /nouvel événement|créer un événement/i }).click();
    await page.waitForURL('**/admin/events/new');
    await page.locator('input[type="text"]').first().fill(name);
    await page.locator('input[type="number"]').first().fill('20');
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByRole('button', { name: /Créer l'événement/i }).click();
    await page.waitForTimeout(500);
    await expect(page.getByText(/token CSRF|Erreur lors de la création/i)).not.toBeVisible();
    await expect(page).toHaveURL(/\/admin(\?|$)/);
  }

  // Each tab mutates independently after its own reload — neither token
  // should have been invalidated by the other tab's hydration.
  await createEventFrom(tab1, 'Multi-Tab Event 1');
  await createEventFrom(tab2, 'Multi-Tab Event 2');
});
