import { test, expect, Page } from '@playwright/test';
import { ADMIN_USERNAME, ADMIN_PASSWORD, getAdminSession, adminApi } from './helpers.js';

async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

test.describe('Wizard de création d\'événement', () => {
  test('un événement créé via le wizard reste en draft pour relecture avant le live', async ({ page }) => {
    await loginAsAdmin(page);
    // Navigate via the in-app link (client-side route change), not
    // page.goto(), which would force a full reload and wipe the in-memory
    // CSRF token just set at login — a different bug, covered separately.
    await page.getByRole('link', { name: /nouvel événement|créer un événement/i }).click();
    await page.waitForURL('**/admin/events/new');

    await page.locator('input[type="text"]').first().fill('Repro Draft Wizard');
    await page.locator('input[type="number"]').first().fill('50');
    await page.getByRole('button', { name: 'Suivant' }).click(); // step1 -> step2
    await page.getByRole('button', { name: 'Suivant' }).click(); // step2 -> step3
    await page.getByRole('button', { name: 'Suivant' }).click(); // step3 -> step4
    await page.getByRole('button', { name: /Créer l'événement/i }).click();
    await page.waitForTimeout(1000);

    // The wizard must not surface an error while creating the event, and
    // the flow must land back on the dashboard.
    await expect(page.getByText(/Erreur lors de la création/i)).not.toBeVisible();
    await expect(page).toHaveURL(/\/admin$/);

    const session = await getAdminSession();
    const events = await adminApi<any[]>(session, 'GET', '/api/v1/events');
    const created = events.find((e) => e.name === 'Repro Draft Wizard');
    expect(created).toBeTruthy();

    // A newly created event must stay in `draft` so staff can review the
    // topology and run a preflight before it goes live. Today the wizard
    // calls POST /events/:id/start automatically at the end of step 4, with
    // no separate review step — the event comes back `live`.
    expect(created.status).toBe('draft');
  });

  test('le wizard permet de configurer plusieurs portes entre les mêmes espaces', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: /nouvel événement|créer un événement/i }).click();
    await page.waitForURL('**/admin/events/new');

    await page.locator('input[type="text"]').first().fill('Repro Multi Checkpoint');
    await page.locator('input[type="number"]').first().fill('100');
    await page.getByRole('button', { name: 'Suivant' }).click(); // step1 -> step2
    await page.getByRole('button', { name: 'Suivant' }).click(); // step2 -> step3

    // Step 3 must let staff add further checkpoints (e.g. 3 doors between
    // "Extérieur" and "Site", per the acceptance scenario). Today the form
    // is hard-bound to a single checkpoint (checkpoints[0]) with no control
    // to add another one.
    await expect(
      page.getByRole('button', { name: /ajouter une porte|ajouter un checkpoint/i })
    ).toBeVisible();
  });
});
