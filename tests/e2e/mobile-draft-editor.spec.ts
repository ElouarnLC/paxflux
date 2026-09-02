import { test, expect, Page } from '@playwright/test';
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  AdminSession,
  adminApi,
  LONG_FIXTURE_NAMES,
  LongNamedTopology,
  createLongNamedTopology,
  getAdminSession,
  getEventSpaces,
} from './helpers.js';
import {
  assertFieldsDoNotTriggerIosZoom,
  assertScreenFitsViewport,
  assertTouchTargets,
} from './responsive-helpers.js';

/**
 * The draft editor at every viewport in the matrix, 320 to 1280.
 *
 * It is the densest admin screen in the product: per-zone name and capacity
 * on one row, per-door name plus two endpoint selectors plus two directions
 * each with a checkbox and a free-text label. Every one of those rows holds
 * a real event's names here, not "Site" and "Porte" — an interface that only
 * works with short fixtures has not been asked the question.
 *
 * The draft is left as a draft on purpose: this is the one screen that
 * exists only before an event starts, so it cannot be reached at all from a
 * fixture that goes live.
 */

let session: AdminSession;
let topo: LongNamedTopology;

test.beforeAll(async () => {
  session = await getAdminSession();
  topo = await createLongNamedTopology(session, { suffix: `edit-${test.info().project.name}` });
});

async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

async function openEditor(page: Page) {
  await loginAsAdmin(page);
  await page.goto(`/admin/events/${topo.eventId}/edit`);
  await expect(page.getByRole('heading', { name: 'Modifier le brouillon' })).toBeVisible();
  // The doors render last; waiting on one means the whole form is laid out
  // before anything is measured.
  await expect(
    page.getByLabel(`Nom de la porte ${LONG_FIXTURE_NAMES.mainCheckpoint}`)
  ).toBeVisible();
}

test('l’éditeur de brouillon tient dans le viewport avec des noms réels', async ({ page }) => {
  await openEditor(page);
  await assertScreenFitsViewport(page, "/admin/events/:id/edit (éditeur de brouillon)");
});

test('les contrôles de l’éditeur restent atteignables au doigt', async ({ page }) => {
  await openEditor(page);

  // The direction checkboxes are the hardest targets on the screen: they are
  // drawn at 20px, so each one leans on the <label> around it for its 44×44.
  await assertTouchTargets(page, '/admin/events/:id/edit');
  await assertFieldsDoNotTriggerIosZoom(page, '/admin/events/:id/edit');
});

test('l’éditeur reste utilisable après l’ajout d’une zone et d’une porte', async ({ page }) => {
  await openEditor(page);

  // Growth is where a fixed layout breaks: one more zone widens every
  // endpoint selector's longest option, and one more door adds a row that
  // has to survive the same width.
  await page.getByRole('button', { name: 'Ajouter une zone' }).click();
  await expect(page.getByTestId('draft-save-state')).toContainText('Enregistré à', { timeout: 15_000 });

  await page.getByRole('button', { name: 'Ajouter une porte' }).click();
  await expect(page.getByTestId('draft-save-state')).toContainText('Enregistré à', { timeout: 15_000 });

  await expect(page.getByLabel('Nom de la porte Nouvelle porte')).toBeVisible();
  await assertScreenFitsViewport(page, '/admin/events/:id/edit (après ajouts)');
  await assertTouchTargets(page, '/admin/events/:id/edit (après ajouts)');
});

test('un sens de passage se lit en entier, sans troncature ni vocabulaire A/B', async ({ page }) => {
  await openEditor(page);

  const spaces = await getEventSpaces(session, topo.eventId);
  const site = spaces.find((s: any) => s.name === LONG_FIXTURE_NAMES.siteSpace);
  const vip = spaces.find((s: any) => s.name === LONG_FIXTURE_NAMES.vipSpace);

  // Two long zone names in one sentence is the worst case at 320px, and
  // `assertScreenFitsViewport` above already forbids it overflowing — this
  // asserts the sentence is actually there rather than shortened away.
  await expect(page.getByText(`De ${site.name} vers ${vip.name}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`De ${vip.name} vers ${site.name}`, { exact: true })).toBeVisible();

  await expect(page.getByText('Espace A', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Espace B', { exact: true })).toHaveCount(0);
});

test('l’écran de verrouillage d’un événement non-brouillon tient aussi dans le viewport', async ({
  page,
}) => {
  // Its own event: starting the shared fixture would strand the tests above.
  const locked = await createLongNamedTopology(session, {
    suffix: `locked-${test.info().project.name}`,
  });
  await adminApi(session, 'POST', `/api/v1/events/${locked.eventId}/start`);

  await loginAsAdmin(page);
  await page.goto(`/admin/events/${locked.eventId}/edit`);

  await expect(page.getByRole('heading', { name: 'Préparation verrouillée' })).toBeVisible();
  await assertScreenFitsViewport(page, '/admin/events/:id/edit (verrouillé)');
  await assertTouchTargets(page, '/admin/events/:id/edit (verrouillé)');
});
