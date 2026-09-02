import { test, expect } from '@playwright/test';
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  startEvent,
  beginClosingEvent,
  createDeviceInviteToken,
} from './helpers.js';

// Reproduces the `closing`-UI blocker: LifecycleControls used to fetch the
// device list only once on entering `closing` (or after an error), so a
// device that was offline/pending at load time and later reconnects and
// drains its outbox never updated the admin's view without a manual reload.
test('l\'admin voit un appareil redevenir synchronisé pendant `closing`, sans reload, et le bouton de clôture normale s\'active', async ({ browser }) => {
  test.setTimeout(120_000);

  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'Repro Closing Auto Refresh',
    capacity: 30,
  });
  await startEvent(session, topo.eventId);
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  // The device pairs (this stamps `lastSeenAtMs` = now on the server), then
  // immediately goes offline and queues a tap locally — the server never
  // hears about this tap until the device reconnects.
  const deviceContext = await browser.newContext();
  const devicePage = await deviceContext.newPage();
  await devicePage.goto(`/pair#${token}`);
  await devicePage.waitForURL('**/counter');

  await deviceContext.setOffline(true);
  await devicePage.getByRole('button', { name: /ENTRÉE/i }).click();

  await beginClosingEvent(session, topo.eventId);

  // Let the device's `lastSeenAtMs` age past the server's 45s online
  // threshold, so that when the admin opens the dashboard the very first
  // fetch already reports this device as not synced — reproducing "un
  // appareil était offline/pending au moment du chargement".
  await devicePage.waitForTimeout(46_000);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await adminPage.goto('/login');
  await adminPage.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await adminPage.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await adminPage.getByRole('button', { name: 'Connexion' }).click();
  await adminPage.waitForURL('**/admin');
  await adminPage.goto(`/admin?event=${topo.eventId}`);

  // Scoped to the lifecycle section: the dashboard also renders its own,
  // separate "Appareils et portes actives" table with the same "Hors
  // ligne"/"En ligne" wording, which would otherwise make these locators
  // ambiguous.
  const lifecycleSection = adminPage
    .locator('section')
    .filter({ has: adminPage.getByRole('heading', { name: /Cycle de vie de l'événement/i }) });
  const closeButton = lifecycleSection.getByRole('button', { name: /Clôturer l'événement/i });

  await expect(lifecycleSection.getByText(/hors ligne/i)).toBeVisible({ timeout: 15_000 });
  await expect(
    lifecycleSection.getByText(/tous les appareils actifs soient en ligne et synchronisés/i)
  ).toBeVisible();
  await expect(closeButton).toBeDisabled();

  // The device reconnects and drains its outbox without any help from the
  // admin. No admin reload happens from here on: LifecycleControls' own
  // ~3s polling of GET /events/:id/devices must pick up the change.
  await deviceContext.setOffline(false);
  await expect(devicePage.getByText(/EN LIGNE/)).toBeVisible({ timeout: 10_000 });

  await expect(lifecycleSection.getByText(/hors ligne/i)).not.toBeVisible({ timeout: 15_000 });
  await expect(lifecycleSection.getByText(/en attente/i)).not.toBeVisible();
  await expect(
    lifecycleSection.getByText(/tous les appareils actifs soient en ligne et synchronisés/i)
  ).not.toBeVisible();
  await expect(closeButton).toBeEnabled();
});

test('un bouton « Actualiser » manuel est disponible pendant `closing`', async ({ page }) => {
  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'Repro Closing Manual Refresh',
    capacity: 30,
  });
  await startEvent(session, topo.eventId);
  await beginClosingEvent(session, topo.eventId);

  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
  await page.goto(`/admin?event=${topo.eventId}`);

  await expect(page.getByRole('button', { name: /Actualiser/i })).toBeVisible();
});
