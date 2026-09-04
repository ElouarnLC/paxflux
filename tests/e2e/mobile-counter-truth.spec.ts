import { test, expect, Page } from '@playwright/test';
import {
  AdminSession,
  LONG_FIXTURE_NAMES,
  completeDevicePairing,
  createDeviceInviteToken,
  createLongNamedTopology,
  getAdminSession,
  startEvent,
} from './helpers.js';
import {
  assertFullyVisible,
  assertScreenFitsViewport,
  assertTouchTargets,
  isPhoneViewport,
} from './responsive-helpers.js';

/**
 * RC2-E's new counter copy across the viewport matrix, 320 to 1280.
 *
 * Two lines of explanation were added under the gauge — what the server
 * holds, what this device still owes it, and what is incoherent when
 * something is. On a 320×568 handset the counter had no spare vertical
 * space to give: the risk is not that the sentence looks cramped but that
 * it pushes `ENTRÉE` or `SORTIE` past the fold, which turns an
 * explanation into a counting failure.
 *
 * So each state is entered for real and the primary targets are then
 * required to be wholly on screen, with no scrolling, at every width.
 */

/** SPEC §10.3: the primary targets are deliberately oversized. */
const MIN_PRIMARY_BUTTON_HEIGHT = 120;

let session: AdminSession;

test.beforeAll(async () => {
  session = await getAdminSession();
});

/** A counter paired on the long-name fixture — the worst case for width. */
async function pairLongNamedCounter(page: Page, suffix: string) {
  const topo = await createLongNamedTopology(session, { suffix: `${suffix}-${test.info().project.name}` });
  await startEvent(session, topo.eventId);
  await completeDevicePairing(page, await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId));
  await expect(page.getByTestId('count-a-to-b')).toBeVisible();
  return topo;
}

/**
 * Both count buttons wholly on screen, at full size, with nothing scrolled.
 *
 * Used for the states RC2-E must not degrade — see the per-test comments for
 * which states those are, and which are held to reachability instead.
 */
async function assertCountingStaysVisible(page: Page, label: string) {
  const entry = page.getByTestId('count-a-to-b');
  const exit = page.getByTestId('count-b-to-a');

  await assertFullyVisible(page, entry, `${label} — bouton ENTRÉE`);
  await assertFullyVisible(page, exit, `${label} — bouton SORTIE`);
  await assertScreenFitsViewport(page, label);

  // Fitting must not have been bought by shrinking the targets.
  for (const [name, button] of [
    ['ENTRÉE', entry],
    ['SORTIE', exit],
  ] as const) {
    const box = await button.boundingBox();
    expect(box, `${name}: no box`).not.toBeNull();
    expect(
      box!.height,
      `${label} — ${name}: ${Math.round(box!.height)}px tall, below the ${MIN_PRIMARY_BUTTON_HEIGHT}px the SPEC requires`
    ).toBeGreaterThanOrEqual(MIN_PRIMARY_BUTTON_HEIGHT - 1);
  }

  // The sync badge is how an operator knows whether what they see has
  // reached the server; it is never what gives way to make room.
  await assertFullyVisible(page, page.getByText(/HORS LIGNE|EN LIGNE|SYNC/).first(), `${label} — badge de synchro`);
}

test('la répartition serveur/en attente ne chasse pas les boutons de comptage', async ({ page }) => {
  // The normal state §J names: live, online, and holding counts the server
  // has not acknowledged yet. Stalling the batch endpoint — rather than
  // cutting the network — keeps the offline banner out of the way, so what
  // is measured here is the disclosure line and nothing else.
  await page.route('**/api/v1/device/actions/batch', () => {});
  await pairLongNamedCounter(page, 'rc2e-pending');

  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('count-a-to-b').click();
  }

  const disclosure = page.getByTestId('occupancy-pending-disclosure');
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText('+3 en attente sur cet appareil');

  await assertCountingStaysVisible(page, '/counter — solde en attente');
  // And the explanation itself is readable rather than merely present.
  await assertFullyVisible(page, disclosure, '/counter — répartition serveur/en attente');

  // The gauge is the thing this screen exists for: still whole, still on
  // screen, with the long zone names beside it.
  await assertFullyVisible(page, page.getByTestId('global-occupancy'), '/counter — jauge');
  await expect(page.getByRole('heading', { name: LONG_FIXTURE_NAMES.checkpointName })).toBeVisible();
});

test('en anomalie, les commandes de comptage restent atteignables', async ({ page }) => {
  await page.route('**/api/v1/device/actions/batch', () => {});
  await pairLongNamedCounter(page, 'rc2e-anomaly');

  // An exit counted before any entry. The alert sits between the gauge and
  // the buttons and is the longest text this screen renders.
  await page.getByTestId('count-b-to-a').click();

  const anomaly = page.getByTestId('occupancy-anomaly');
  await expect(anomaly).toBeVisible();
  await expect(anomaly).toContainText('Occupation projetée négative');
  // Never colour alone: the reason is written out.
  await expect(anomaly).toContainText('comptages conservés');
  await assertFullyVisible(page, anomaly, '/counter — alerte anomalie');
  await assertScreenFitsViewport(page, '/counter — anomalie');
  await assertTouchTargets(page, '/counter — anomalie');

  const entry = page.getByTestId('count-a-to-b');
  const exit = page.getByTestId('count-b-to-a');

  // ENTRÉE stays where it was: an anomaly never displaces the first count
  // target.
  await assertFullyVisible(page, entry, '/counter — anomalie, bouton ENTRÉE');

  if (isPhoneViewport(page)) {
    // On the smallest screen in the matrix this state does scroll, and it
    // did before RC2-E: at 320×568 the counter measured 599px with a queued
    // count and no anomaly at all, and 667px offline with an empty outbox.
    // The alert costs a further 64px. What §J requires here is that the
    // controls not become *unreachable*, so that is what is checked — the
    // stricter no-scroll contract belongs to the normal state above.
    await exit.scrollIntoViewIfNeeded();
  }
  await assertFullyVisible(page, exit, '/counter — anomalie, bouton SORTIE atteint');
  await expect(exit).toBeEnabled();

  // Reachable means usable: the tap is really taken.
  await exit.click();
  await expect(page.getByTestId('global-occupancy')).toHaveText('−2');
});

test('l’étape finale d’appairage tient à l’écran avec le test de vibration', async ({ page }) => {
  const topo = await createLongNamedTopology(session, { suffix: `rc2e-haptic-${test.info().project.name}` });
  await startEvent(session, topo.eventId);
  await page.goto(`/pair#${await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId)}`);
  await expect(page.getByText('Appairage réussi')).toBeVisible();

  const testButton = page.getByTestId('test-haptics');
  const continueButton = page.getByRole('button', { name: 'Continuer sans renommer' });

  await assertScreenFitsViewport(page, '/pair — étape finale');
  await assertTouchTargets(page, '/pair — étape finale');

  // The diagnostic sits below the way out, so adding it — and the paragraph
  // it produces — never moves `Continuer`. Recorded here because the first
  // version of this screen put the button above them and pushed both off a
  // 320×568 viewport.
  // Ordering is the invariant, not absolute position: the panel is vertically
  // centred, so on a viewport with room to spare everything shifts when the
  // content grows. What must never happen is the diagnostic appearing *above*
  // the way out — the first version of this screen did exactly that and
  // pushed both continue buttons off a 320×568 viewport.
  const documentTop = (locator: ReturnType<typeof page.getByTestId>) =>
    locator.evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY));

  expect(
    await documentTop(testButton),
    'the diagnostic sits below the way out'
  ).toBeGreaterThan(await documentTop(continueButton));

  await testButton.scrollIntoViewIfNeeded();
  await testButton.click();
  const result = page.getByTestId('haptic-result');
  await expect(result).toBeVisible();

  await assertScreenFitsViewport(page, '/pair — résultat du test de vibration');
  expect(
    await documentTop(result),
    'its answer does too'
  ).toBeGreaterThan(await documentTop(continueButton));

  // And the way out is still reachable and still works.
  await assertFullyVisible(page, continueButton, '/pair — continuer après le test');
  await continueButton.click();
  await page.waitForURL('**/counter');
});
