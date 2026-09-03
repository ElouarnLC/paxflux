import { test, expect, Page } from '@playwright/test';
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  AdminSession,
  adminApi,
  createDeviceInviteToken,
  createDraftEventWithMainCheckpoint,
  getAdminSession,
  getEventDevices,
  startEvent,
} from './helpers.js';
import {
  assertFieldsDoNotTriggerIosZoom,
  assertScreenFitsViewport,
  assertTouchTargets,
} from './responsive-helpers.js';

/**
 * RC2-D device identity across the viewport matrix, 320 to 1280.
 *
 * Two new surfaces have to survive a phone: the pairing completion step,
 * which is the first thing a field operator sees on a handset they are
 * holding one-handed, and the counter header, which now carries a third line
 * of free text next to a sync badge that must never be pushed off screen.
 *
 * The device name is the worst case in both, so it is a long one here.
 */

const LONG_DEVICE_NAME =
  'Téléphone de comptage — entrée nord, poste billetterie principale, équipe du soir';

let session: AdminSession;

test.beforeAll(async () => {
  session = await getAdminSession();
});

async function liveEvent(name: string) {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `${name} · ${test.info().project.name}`,
    capacity: 500,
  });
  await startEvent(session, topo.eventId);
  return topo;
}

async function pairAndStop(page: Page, name: string) {
  const topo = await liveEvent(name);
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
  await page.goto(`/pair#${token}`);
  await expect(page.getByText('Appairage réussi')).toBeVisible();
  return topo;
}

test('l’étape de nommage après appairage tient dans le viewport', async ({ page }) => {
  await pairAndStop(page, 'RC2D mobile nommage');

  await assertScreenFitsViewport(page, '/pair — étape de nommage');
  await assertTouchTargets(page, '/pair — étape de nommage');
  await assertFieldsDoNotTriggerIosZoom(page, '/pair — étape de nommage');

  // With a long name typed in, which is what an operator actually does.
  await page.getByLabel('Nom de cet appareil').fill(LONG_DEVICE_NAME);
  await assertScreenFitsViewport(page, '/pair — nom long saisi');
});

test('le compteur affiche un nom d’appareil long sans chasser le badge de synchro', async ({ page }) => {
  const topo = await pairAndStop(page, 'RC2D mobile compteur');

  await page.getByLabel('Nom de cet appareil').fill(LONG_DEVICE_NAME);
  await page.getByRole('button', { name: 'Continuer avec ce nom' }).click();
  await page.waitForURL('**/counter');

  await expect(page.getByTestId('counter-device-label')).toContainText('Téléphone de comptage');

  // The sync badge is the assertion that matters: a free-text device name in
  // the same flex row as the badge is exactly what would push it out.
  const badge = page.getByText('EN LIGNE');
  await expect(badge).toBeVisible();

  await assertScreenFitsViewport(page, '/counter — nom d’appareil long');
  await assertTouchTargets(page, '/counter — nom d’appareil long');

  // The door is still the heading; the device name did not replace it.
  await expect(page.getByRole('heading', { name: 'Porte Principale' })).toBeVisible();
  expect(topo.eventId).toBeTruthy();
});

test('le renommage administrateur reste atteignable dans le tableau des appareils', async ({ page }) => {
  const topo = await liveEvent('RC2D mobile renommage admin');
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  // Pair through an API-driven context so this page stays a staff browser.
  const devicePage = await page.context().browser()!.newContext();
  const phone = await devicePage.newPage();
  await phone.goto(`/pair#${token}`);
  await phone.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await phone.waitForURL('**/counter');
  await devicePage.close();

  const devices = await getEventDevices(session, topo.eventId);
  await adminApi(session, 'PATCH', `/api/v1/device-sessions/${devices[0].id}`, {
    label: LONG_DEVICE_NAME,
  });

  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
  await page.goto(`/admin/events/${topo.eventId}/devices`);

  // The table scrolls inside its own container rather than widening the
  // page, so the rename control is reachable at every viewport.
  const rename = page.getByRole('button', { name: `Renommer ${LONG_DEVICE_NAME}` });
  await expect(rename).toBeVisible();
  await rename.scrollIntoViewIfNeeded();

  await assertScreenFitsViewport(page, '/admin/events/:id/devices — nom long');

  // And the dialog it opens is usable on a phone.
  await rename.click();
  await expect(page.getByLabel('Nom de l’appareil')).toBeVisible();
  await assertScreenFitsViewport(page, 'dialogue de renommage');
  await assertTouchTargets(page, 'dialogue de renommage');
  await assertFieldsDoNotTriggerIosZoom(page, 'dialogue de renommage');
});

test('l’écran serveur injoignable de la racine tient dans le viewport', async ({ page }) => {
  await page.route('**/api/v1/meta', (route) => route.abort('failed'));

  await page.goto('/');
  await expect(page.getByTestId('root-server-unavailable')).toBeVisible();

  // The state is written, not signalled by colour alone.
  await expect(page.getByText('Impossible de joindre le serveur')).toBeVisible();

  await assertScreenFitsViewport(page, '/ — serveur injoignable');
  await assertTouchTargets(page, '/ — serveur injoignable');
});
