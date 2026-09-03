import { test, expect, Page } from '@playwright/test';
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  AdminSession,
  getAdminSession,
  createLongNamedTopology,
  startEvent,
  beginClosingEvent,
  LongNamedTopology,
} from './helpers.js';
import {
  assertFullyVisible,
  assertPortalSafeArea,
  assertScreenFitsViewport,
  assertTouchTargets,
} from './responsive-helpers.js';

/**
 * The dialogs, on a phone.
 *
 * A confirmation that runs off the bottom of a 320×568 screen is worse than
 * no confirmation: the operator sees the question and cannot reach the
 * answer. These run across the whole viewport matrix for the same reason
 * every other responsive spec does.
 */

let session: AdminSession;
let topo: LongNamedTopology;

test.beforeAll(async () => {
  session = await getAdminSession();
  topo = await createLongNamedTopology(session, { suffix: `dlg-${test.info().project.name}` });
  await startEvent(session, topo.eventId);
  await beginClosingEvent(session, topo.eventId);
});

async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

test('un dialogue de confirmation tient dans le viewport et respecte les zones de sécurité', async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);

  // The force-close dialog is the longest one in the product: a paragraph
  // of consequences, a labelled field and a hint, plus two actions.
  await page.getByRole('button', { name: /Fermeture forcée/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await assertPortalSafeArea(page, '/admin — dialogue de fermeture forcée');
  await assertFullyVisible(page, dialog, '/admin — dialogue de fermeture forcée');
  await assertScreenFitsViewport(page, '/admin — dialogue de fermeture forcée');
  await assertTouchTargets(page, '/admin — dialogue de fermeture forcée');

  // Deliberately not asserting that the page behind does not scroll: Radix
  // locks it with `overflow: hidden` while the dialog is open, so that
  // assertion could not fail and would prove nothing. What can fail is
  // whether the dialog itself gives long content somewhere to go.
  const scrollsInternally = await dialog.evaluate((el) => {
    const body = Array.from(el.querySelectorAll('*')).find(
      (child) => getComputedStyle(child).overflowY === 'auto'
    );
    return body !== undefined;
  });
  expect(
    scrollsInternally,
    'the dialog has no internal scroll area, so content past the fold is unreachable on a small screen'
  ).toBe(true);
});

test('une alerte de confirmation tient également dans le viewport', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);

  await page.getByRole('button', { name: "Clôturer l’événement" }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();

  await assertPortalSafeArea(page, '/admin — alerte de clôture');
  await assertFullyVisible(page, dialog, '/admin — alerte de clôture');
  await assertScreenFitsViewport(page, '/admin — alerte de clôture');
  await assertTouchTargets(page, '/admin — alerte de clôture');
});
