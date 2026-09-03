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
import {
  assertFieldsDoNotTriggerIosZoom,
  assertSafeAreaContract,
  assertTouchTargets,
  assertVisibleFocusIndicator,
} from './responsive-helpers.js';

/**
 * Phone ergonomics: the viewport the user is allowed to control, fields
 * that do not hijack the screen on focus, keyboard focus that can be seen,
 * and targets a thumb can actually hit.
 */

let session: AdminSession;
let topo: LongNamedTopology;

test.beforeAll(async () => {
  session = await getAdminSession();
  topo = await createLongNamedTopology(session, { suffix: `ergo-${test.info().project.name}` });
  await startEvent(session, topo.eventId);
});

async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

test('le zoom utilisateur n’est pas interdit par le meta viewport', async ({ page }) => {
  await page.goto('/login');

  const content = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(content, 'the document declares no viewport meta at all').not.toBeNull();
  const viewportMeta = (content || '').toLowerCase();

  expect(
    viewportMeta,
    `the viewport meta forbids pinch-zoom (${viewportMeta}) — an operator who cannot read a value has no way to enlarge it`
  ).not.toMatch(/user-scalable\s*=\s*(no|0)/);

  // `maximum-scale=1` disables zoom just as effectively as
  // `user-scalable=no`, and iOS honours it.
  const maximumScale = viewportMeta.match(/maximum-scale\s*=\s*([0-9.]+)/);
  expect(
    maximumScale === null || parseFloat(maximumScale[1]) >= 5,
    `the viewport meta caps zoom at ${maximumScale?.[1]} (${viewportMeta}); WCAG 1.4.4 expects at least 5×`
  ).toBe(true);

  expect(viewportMeta, 'the viewport meta must still adapt to the device width').toContain(
    'width=device-width'
  );
});

test('le texte reste sélectionnable en dehors des surfaces tactiles', async ({ page }) => {
  await page.goto('/login');

  // A global `select-none` on <body> makes every value in the admin
  // interface — a pairing URL, a checksum, an event name — impossible to
  // copy. It belongs on the counter's tap surfaces, not on the document.
  const bodyUserSelect = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return style.userSelect || (style as unknown as { webkitUserSelect: string }).webkitUserSelect;
  });

  expect(
    bodyUserSelect,
    '<body> disables text selection globally, so no value in the interface can be copied'
  ).not.toBe('none');
});

test('les zones de sécurité sont appliquées une seule fois, à la racine', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);
  await expect(page.getByText(LONG_FIXTURE_NAMES.siteSpace).first()).toBeVisible();

  // The dashboard is the screen with a sticky bar carrying the event
  // selector and both shortcuts — the content that must not end up under a
  // status bar.
  await expect(page.locator('header')).toBeVisible();
  await assertSafeAreaContract(page, '/admin (Dashboard)');

  // And the counter, the only full-bleed screen and therefore the one most
  // likely to be given an inset of its own on top of #root's.
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
  await completeDevicePairing(page, token);
  await expect(page.getByTestId('count-a-to-b')).toBeVisible();
  await assertSafeAreaContract(page, '/counter (CounterView)');
});

test('les champs de saisie n’imposent pas le zoom iOS au focus', async ({ page }) => {
  await page.goto('/login');
  await assertFieldsDoNotTriggerIosZoom(page, '/login');

  await page.goto('/setup');
  await expect(page.getByRole('button', { name: 'Créer le compte et démarrer' })).toBeVisible();
  await assertFieldsDoNotTriggerIosZoom(page, '/setup');

  await loginAsAdmin(page);
  await assertFieldsDoNotTriggerIosZoom(page, '/admin (Dashboard)');

  await page.goto('/admin/events/new');
  await expect(page.getByRole('heading', { name: '1. Informations Générales' })).toBeVisible();
  await assertFieldsDoNotTriggerIosZoom(page, '/admin/events/new — étape 1');

  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByRole('heading', { name: '2. Espaces' })).toBeVisible();
  await assertFieldsDoNotTriggerIosZoom(page, '/admin/events/new — étape 2');

  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByRole('heading', { name: '3. Portes & Checkpoints' })).toBeVisible();
  await assertFieldsDoNotTriggerIosZoom(page, '/admin/events/new — étape 3');

  await page.goto(`/admin/events/${topo.eventId}/devices`);
  await expect(page.getByRole('heading', { name: 'Gestion des Appareils et QR Codes' })).toBeVisible();
  await assertFieldsDoNotTriggerIosZoom(page, '/admin/events/:id/devices');
});

test('le focus clavier reste visible sur les contrôles principaux', async ({ page }) => {
  await page.goto('/login');
  await assertVisibleFocusIndicator(page, page.getByPlaceholder('admin'), '/login — nom d’utilisateur');
  await assertVisibleFocusIndicator(
    page,
    page.getByRole('button', { name: 'Connexion' }),
    '/login — bouton Connexion'
  );

  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);
  await assertVisibleFocusIndicator(
    page,
    page.getByRole('combobox'),
    '/admin — sélecteur d’événement'
  );
  await assertVisibleFocusIndicator(
    page,
    page.getByRole('link', { name: /Nouvel événement/ }),
    '/admin — Nouvel événement'
  );
});

test('les cibles tactiles des écrans admin sont assez grandes', async ({ page }) => {
  await loginAsAdmin(page);

  await page.goto(`/admin?event=${topo.eventId}`);
  await expect(page.getByText(LONG_FIXTURE_NAMES.siteSpace).first()).toBeVisible();
  await assertTouchTargets(page, '/admin (Dashboard)');

  await page.goto('/admin/events/new');
  await expect(page.getByRole('heading', { name: '1. Informations Générales' })).toBeVisible();
  await assertTouchTargets(page, '/admin/events/new — étape 1');

  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByRole('heading', { name: '2. Espaces' })).toBeVisible();
  await page.getByLabel("Nom de l'espace intérieur").first().fill(LONG_FIXTURE_NAMES.siteSpace);
  await page.getByRole('button', { name: 'Ajouter un espace intérieur' }).click();
  await page.getByLabel("Nom de l'espace intérieur").nth(1).fill(LONG_FIXTURE_NAMES.vipSpace);
  // Two rows means the per-row delete button is enabled and therefore a
  // real target — the single-row case is disabled and never tapped.
  await assertTouchTargets(page, '/admin/events/new — étape 2');

  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByRole('heading', { name: '3. Portes & Checkpoints' })).toBeVisible();
  await page.getByRole('button', { name: 'Ajouter une porte' }).click();
  await assertTouchTargets(page, '/admin/events/new — étape 3');

  await page.goto(`/admin/events/${topo.eventId}/devices`);
  await expect(page.getByRole('heading', { name: 'Gestion des Appareils et QR Codes' })).toBeVisible();
  await page.getByRole('button', { name: /Générer le QR Code/ }).click();
  await expect(page.getByText('QR Code Prêt pour scan')).toBeVisible();
  await assertTouchTargets(page, '/admin/events/:id/devices');

  await page.goto(`/admin/events/${topo.eventId}/analytics`);
  await expect(page.getByRole('heading', { name: 'Statistiques et analyse de flux' })).toBeVisible();
  await assertTouchTargets(page, '/admin/events/:id/analytics');

  await page.goto('/admin/system');
  await expect(page.getByRole('heading', { name: 'État Système & Sauvegardes' })).toBeVisible();
  await assertTouchTargets(page, '/admin/system');
});

test('les cibles tactiles du compteur sont assez grandes', async ({ page }) => {
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
  await completeDevicePairing(page, token);
  await expect(page.getByTestId('count-a-to-b')).toBeVisible();

  // A count, so ANNULER — the one destructive control on the field
  // interface — is rendered and measured too.
  await page.getByTestId('count-a-to-b').click();
  await expect(page.getByRole('button', { name: 'ANNULER' })).toBeVisible();

  await assertTouchTargets(page, '/counter (CounterView)');
});

test('la surface de comptage reste protégée de la sélection accidentelle', async ({ page }) => {
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
  await completeDevicePairing(page, token);

  // The inverse of the body assertion above: removing the global rule must
  // not remove it where it is actually needed. Repeated taps on a large
  // button select its label otherwise, and the phone offers a copy menu
  // mid-count.
  const buttonUserSelect = await page.getByTestId('count-a-to-b').evaluate((el) => {
    const style = getComputedStyle(el);
    return style.userSelect || (style as unknown as { webkitUserSelect: string }).webkitUserSelect;
  });

  expect(
    buttonUserSelect,
    'the primary count button no longer suppresses text selection; repeated taps will raise a selection menu'
  ).toBe('none');
});
