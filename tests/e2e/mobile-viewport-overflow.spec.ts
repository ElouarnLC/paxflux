import { test, expect, Page } from '@playwright/test';
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  AdminSession,
  LONG_FIXTURE_NAMES,
  LongNamedTopology,
  completeDevicePairing,
  createDeviceInviteToken,
  createLongNamedTopology,
  getAdminSession,
  startEvent,
} from './helpers.js';
import { assertScreenFitsViewport } from './responsive-helpers.js';

/**
 * Every screen an operator can actually reach, at every viewport in the
 * matrix, holding content of the length a real event produces.
 *
 * The fixtures matter as much as the assertions: an interface that only
 * works with "Site", "Porte" and "Festival" has not been asked the
 * question. Names here are the length the shared contract allows, which is
 * the length staff will use.
 */

let session: AdminSession;
let topo: LongNamedTopology;

test.beforeAll(async () => {
  session = await getAdminSession();
  topo = await createLongNamedTopology(session, { suffix: test.info().project.name });
  await startEvent(session, topo.eventId);
});

/**
 * The wizard names a direction's label field for the movement it describes
 * ("De Extérieur vers …"), not for A/B. Both doors this spec creates keep
 * the seeded Extérieur <-> first-zone endpoints, so both share these two
 * labels and the positional selectors below still tell them apart.
 */
const inboundLabel = (page: Page) =>
  page.getByLabel(`Libellé du bouton : De Extérieur vers ${LONG_FIXTURE_NAMES.siteSpace}`);
const outboundLabel = (page: Page) =>
  page.getByLabel(`Libellé du bouton : De ${LONG_FIXTURE_NAMES.siteSpace} vers Extérieur`);

async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

test('les écrans d’entrée tiennent dans le viewport', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Connexion' })).toBeVisible();
  await assertScreenFitsViewport(page, '/login');

  await page.goto('/setup');
  await expect(page.getByRole('button', { name: 'Créer le compte et démarrer' })).toBeVisible();
  await assertScreenFitsViewport(page, '/setup');

  // No token in the fragment: the pairing page must render its refusal
  // inside the viewport, not push it off the side of a phone.
  await page.goto('/pair');
  await expect(page.getByText('Erreur d’appairage')).toBeVisible();
  await assertScreenFitsViewport(page, '/pair (sans token)');
});

test('le tableau de bord tient dans le viewport avec un événement au nom long', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);

  // The long name is on screen — otherwise this would be measuring an
  // empty dashboard and proving nothing.
  await expect(page.getByText(LONG_FIXTURE_NAMES.siteSpace).first()).toBeVisible();
  await assertScreenFitsViewport(page, '/admin (Dashboard)');
});

test('les quatre étapes du wizard tiennent dans le viewport', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/events/new');

  // Step 1 — general. A long event name and a wide capacity, side by side
  // with the timezone.
  await expect(page.getByRole('heading', { name: '1. Informations Générales' })).toBeVisible();
  await page.locator('input[type="text"]').first().fill(LONG_FIXTURE_NAMES.event);
  await page.locator('input[type="number"]').first().fill('12500');
  await assertScreenFitsViewport(page, '/admin/events/new — étape 1 (Général)');

  // Step 2 — spaces: name, capacity and delete on one row, twice.
  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByRole('heading', { name: '2. Espaces' })).toBeVisible();
  await page.getByLabel("Nom de l’espace intérieur").first().fill(LONG_FIXTURE_NAMES.siteSpace);
  await page.getByLabel("Capacité de l’espace").first().fill('12500');
  await page.getByRole('button', { name: 'Ajouter un espace intérieur' }).click();
  await page.getByLabel("Nom de l’espace intérieur").nth(1).fill(LONG_FIXTURE_NAMES.vipSpace);
  await page.getByLabel("Capacité de l’espace").nth(1).fill('850');
  await assertScreenFitsViewport(page, '/admin/events/new — étape 2 (Espaces)');

  // Step 3 — doors: two endpoints and two directional labels per door.
  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByRole('heading', { name: '3. Portes' })).toBeVisible();
  await page.getByLabel('Nom de la porte').first().fill(LONG_FIXTURE_NAMES.mainCheckpoint);
  await inboundLabel(page).first().fill(LONG_FIXTURE_NAMES.labelAToB);
  await outboundLabel(page).first().fill(LONG_FIXTURE_NAMES.labelBToA);
  await page.getByRole('button', { name: 'Ajouter une porte' }).click();
  await page.getByLabel('Nom de la porte').nth(1).fill(LONG_FIXTURE_NAMES.innerCheckpoint);
  await inboundLabel(page).nth(1).fill(LONG_FIXTURE_NAMES.innerLabelAToB);
  await outboundLabel(page).nth(1).fill(LONG_FIXTURE_NAMES.innerLabelBToA);
  await assertScreenFitsViewport(page, '/admin/events/new — étape 3 (Portes)');

  // Step 4 — the topology summary, where every long string appears at once.
  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByRole('heading', { name: '4. Validation de la Topologie' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Créer l’événement/ })).toBeVisible();
  await assertScreenFitsViewport(page, '/admin/events/new — étape 4 (Validation)');
});

test('la gestion des appareils et le QR généré tiennent dans le viewport', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`/admin/events/${topo.eventId}/devices`);
  await expect(page.getByRole('heading', { name: 'Gestion des appareils et QR codes' })).toBeVisible();
  await assertScreenFitsViewport(page, '/admin/events/:id/devices');

  // The generated QR panel: a 180px code, a badge, explanatory copy and a
  // full pairing URL — the densest block in the admin interface.
  await page.getByRole('button', { name: /Générer le QR Code/ }).click();
  await expect(page.getByText('QR Code Prêt pour scan')).toBeVisible();
  await assertScreenFitsViewport(page, '/admin/events/:id/devices — panneau QR généré');
});

test('les statistiques et l’état système tiennent dans le viewport', async ({ page }) => {
  await loginAsAdmin(page);

  await page.goto(`/admin/events/${topo.eventId}/analytics`);
  await expect(page.getByRole('heading', { name: 'Statistiques et analyse de flux' })).toBeVisible();
  await assertScreenFitsViewport(page, '/admin/events/:id/analytics');

  await page.goto('/admin/system');
  await expect(page.getByRole('heading', { name: 'État système et sauvegardes' })).toBeVisible();
  await assertScreenFitsViewport(page, '/admin/system');
});

test('le compteur tient dans le viewport', async ({ page }) => {
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
  await completeDevicePairing(page, token);
  await expect(page.getByTestId('count-a-to-b')).toBeVisible();
  await assertScreenFitsViewport(page, '/counter (CounterView)');
});
