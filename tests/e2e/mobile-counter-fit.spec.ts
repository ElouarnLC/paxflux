import { test, expect } from '@playwright/test';
import {
  AdminSession,
  LONG_FIXTURE_NAMES,
  LongNamedTopology,
  beginClosingEvent,
  completeDevicePairing,
  createDeviceInviteToken,
  createLongNamedTopology,
  getAdminSession,
  startEvent,
} from './helpers.js';
import {
  assertFullyVisible,
  assertTextContrast,
  assertNoVerticalScrolling,
  assertScreenFitsViewport,
  isPhoneViewport,
} from './responsive-helpers.js';

/**
 * The counter is the surface this product is judged on: it is held in one
 * hand, in the dark, next to a queue. Both primary actions have to be
 * there, at a size a thumb can hit, without an operator scrolling to find
 * the one they need.
 */

/** SPEC §10.3: the primary targets are deliberately oversized. */
const MIN_PRIMARY_BUTTON_HEIGHT = 120;
/** …and deliberately not unbounded, so a tablet does not get two slabs. */
const MAX_PRIMARY_BUTTON_HEIGHT = 180;

let session: AdminSession;

test.beforeAll(async () => {
  session = await getAdminSession();
});

async function pairCounter(page: import('@playwright/test').Page, topo: LongNamedTopology) {
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
  await completeDevicePairing(page, token);
  await expect(page.getByTestId('count-a-to-b')).toBeVisible();
}

test('en état normal, ENTRÉE et SORTIE sont utilisables sans défilement', async ({ page }) => {
  const topo = await createLongNamedTopology(session, { suffix: `fit-${test.info().project.name}` });
  await startEvent(session, topo.eventId);
  await pairCounter(page, topo);

  const entry = page.getByTestId('count-a-to-b');
  const exit = page.getByTestId('count-b-to-a');

  // The normal state: live event, valid session, empty outbox, both
  // directions allowed. Nothing here should require moving the page.
  await assertNoVerticalScrolling(page, '/counter (état normal)');
  await assertFullyVisible(page, entry, '/counter — bouton ENTRÉE');
  await assertFullyVisible(page, exit, '/counter — bouton SORTIE');
  await assertScreenFitsViewport(page, '/counter (état normal)');

  // Fitting must not have been bought by shrinking the targets.
  for (const [label, button] of [
    ['ENTRÉE', entry],
    ['SORTIE', exit],
  ] as const) {
    const box = await button.boundingBox();
    expect(box, `${label}: no box`).not.toBeNull();
    expect(
      box!.height,
      `${label}: ${Math.round(box!.height)}px tall — below the ${MIN_PRIMARY_BUTTON_HEIGHT}px the SPEC requires of a primary count target`
    ).toBeGreaterThanOrEqual(MIN_PRIMARY_BUTTON_HEIGHT - 1);
    expect(
      box!.height,
      `${label}: ${Math.round(box!.height)}px tall — beyond the ${MAX_PRIMARY_BUTTON_HEIGHT}px ceiling, which wastes a large screen`
    ).toBeLessThanOrEqual(MAX_PRIMARY_BUTTON_HEIGHT + 1);
  }

  // And the long names really are on screen while it fits.
  //
  // Addressed as the heading rather than as text: RC2-D added the device
  // name below it, and the label a freshly paired handset is given contains
  // the door's own name. Naming the heading is what this assertion always
  // meant — the door is the identity a count belongs to.
  await expect(page.getByRole('heading', { name: LONG_FIXTURE_NAMES.mainCheckpoint })).toBeVisible();
  await expect(entry).toContainText(LONG_FIXTURE_NAMES.labelAToB);
});

test('le compteur est dimensionné en hauteur de viewport dynamique', async ({ page }) => {
  const topo = await createLongNamedTopology(session, { suffix: `dvh-${test.info().project.name}` });
  await startEvent(session, topo.eventId);
  await pairCounter(page, topo);

  // `100vh` — and `height: 100%` chained down from <html> — is the viewport
  // height *without* the browser chrome on mobile. A counter sized that way
  // is taller than the screen exactly when the operator arrives and the
  // address bar is still showing, which pushes ANNULER out of reach. `dvh`
  // is the unit that tracks the area actually visible.
  const units = await page.evaluate(() => {
    const found = { dynamic: false, staticVh: [] as string[] };

    // Modern Chrome implements nested CSS, so a plain style rule also
    // exposes `cssRules` — every rule is visited as a rule *and* descended
    // into, rather than one or the other.
    function walk(rules: CSSRuleList) {
      for (const rule of Array.from(rules)) {
        const selector = (rule as CSSStyleRule).selectorText;
        if (selector) {
          const text = rule.cssText;
          if (/[\d.]+dvh\b/.test(text)) found.dynamic = true;
          if (/[\d.]+vh\b/.test(text) && !/[\d.]+[ds]vh\b/.test(text)) found.staticVh.push(text.slice(0, 140));
        }
        const nested = (rule as CSSGroupingRule).cssRules;
        if (nested && nested.length > 0) walk(nested);
      }
    }

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {
        // cross-origin stylesheet: not one of ours, nothing to inspect
      }
    }
    return found;
  });

  expect(
    units.dynamic,
    'no stylesheet rule uses a dynamic viewport height unit — the counter still assumes a fixed viewport'
  ).toBe(true);
  expect(
    units.staticVh,
    `stylesheet rules still size layout in static vh:\n${units.staticVh.join('\n')}`
  ).toEqual([]);

  // The observable consequence, which is what actually matters.
  await assertNoVerticalScrolling(page, '/counter (hauteur dynamique)');
});

test('un état exceptionnel n’enferme aucune action hors de l’écran', async ({ page }) => {
  const topo = await createLongNamedTopology(session, { suffix: `banner-${test.info().project.name}` });
  await startEvent(session, topo.eventId);
  await pairCounter(page, topo);

  // Offline: the widest banner state an operator meets in normal service.
  await page.context().setOffline(true);
  await expect(page.getByText('Mode Hors Ligne Actif')).toBeVisible();

  // A banner may push the page taller than the screen — that is legitimate
  // — but it must never widen it, and every action must remain reachable.
  await assertScreenFitsViewport(page, '/counter (hors ligne)');
  await page.getByTestId('count-b-to-a').scrollIntoViewIfNeeded();
  await assertFullyVisible(page, page.getByTestId('count-b-to-a'), '/counter hors ligne — bouton SORTIE');

  await page.context().setOffline(false);

  // Closing: counting stops, and the notice must fit alongside everything
  // else rather than shoulder it off the side.
  await beginClosingEvent(session, topo.eventId);
  await expect(page.getByText('Événement en cours de fermeture')).toBeVisible({ timeout: 15_000 });
  await assertScreenFitsViewport(page, '/counter (fermeture en cours)');

  // Disabled is a state with its own colours: the fill becomes `muted` and
  // the labels `muted-foreground`. Measured here too, because a sub-label
  // that pinned a colour instead of inheriting one would stay white on a
  // grey button and only this state would show it.
  await assertTextContrast(page, '#root', '/counter (fermeture en cours)');
});

test('le compteur reste exploitable au clavier et sur grand écran', async ({ page }) => {
  const topo = await createLongNamedTopology(session, { suffix: `desk-${test.info().project.name}` });
  await startEvent(session, topo.eventId);
  await pairCounter(page, topo);

  // Mobile-first must not mean "unusable anywhere else": the same two
  // actions have to hold their shape at 1280×800 as well, which is what
  // the desktop project in this matrix is here to check.
  await assertFullyVisible(page, page.getByTestId('count-a-to-b'), '/counter — ENTRÉE');
  await assertFullyVisible(page, page.getByTestId('count-b-to-a'), '/counter — SORTIE');

  if (!isPhoneViewport(page)) {
    await assertNoVerticalScrolling(page, '/counter (grand écran)');
  }
});

test('chaque libellé des boutons de comptage atteint son seuil de contraste', async ({ page }) => {
  const topo = await createLongNamedTopology(session, { suffix: `contrast-${test.info().project.name}` });
  await startEvent(session, topo.eventId);
  await pairCounter(page, topo);

  // Measured on the whole counter, and per element: the two count buttons
  // each carry a 24–30px black headline *and* a 12px medium "Vers …" line.
  // Auditing the token pair once, at the headline's threshold, is what let
  // the sub-label ship at 3.3:1 — so the assertion enumerates every piece
  // of text and gives each the threshold its own size and weight earn.
  await assertTextContrast(page, '#root', '/counter (état normal)');

  // Named explicitly as well, so a future refactor that removes the
  // sub-labels turns this into a failure rather than a silent pass.
  const subLabels = await page.evaluate(() =>
    ['count-a-to-b', 'count-b-to-a'].map((id) => {
      const button = document.querySelector(`[data-testid="${id}"]`)!;
      const sub = button.querySelector('span:last-of-type')!;
      const style = getComputedStyle(sub);
      return {
        id,
        text: (sub.textContent || '').trim().slice(0, 30),
        fontPx: parseFloat(style.fontSize),
        // The alpha that made the token table lie. It must be gone.
        opaque: !/\/\s*0?\.\d+\s*\)/.test(style.color) && !style.color.includes('rgba'),
      };
    })
  );

  for (const sub of subLabels) {
    expect(sub.text.length, `${sub.id}: the "Vers …" sub-label is missing`).toBeGreaterThan(0);
    expect(
      sub.fontPx,
      `${sub.id}: the sub-label is ${sub.fontPx}px — if it ever reaches 24px it would become "large text" and quietly drop to a 3:1 target`
    ).toBeLessThan(24);
    expect(
      sub.opaque,
      `${sub.id}: the sub-label is drawn with a translucent colour (${JSON.stringify(sub)}); alpha on a foreground is a contrast reduction that no token table shows`
    ).toBe(true);
  }
});
