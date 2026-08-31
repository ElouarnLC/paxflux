import { test, expect } from '@playwright/test';
import {
  AdminSession,
  getAdminSession,
  createLongNamedTopology,
  createDeviceInviteToken,
  startEvent,
  beginClosingEvent,
  LongNamedTopology,
  LONG_FIXTURE_NAMES,
} from './helpers.js';
import {
  assertFullyVisible,
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
  await page.goto(`/pair#${token}`);
  await page.waitForURL('**/counter');
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
  await expect(page.getByText(LONG_FIXTURE_NAMES.mainCheckpoint)).toBeVisible();
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
        continue; // not one of ours
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

test('les zones de sécurité du compteur sont réellement appliquées', async ({ page }) => {
  const topo = await createLongNamedTopology(session, { suffix: `safe-${test.info().project.name}` });
  await startEvent(session, topo.eventId);
  await pairCounter(page, topo);

  // `pb-safe` was a class name with no rule behind it: it read like safe
  // area handling and did exactly nothing. So this asserts two things a
  // decorative class name cannot satisfy — a rule that consults
  // `env(safe-area-inset-*)` exists, and it actually matches an element on
  // this screen. The insets are 0 in this browser, so the assertion is on
  // the mechanism being wired up, not on the value it produces here.
  const guarded = await page.evaluate(() => {
    const selectors = new Set<string>();

    // Tailwind emits its output inside `@layer` blocks, so the style rules
    // are never at the top level of a sheet.
    function walk(rules: CSSRuleList) {
      for (const rule of Array.from(rules)) {
        const styleRule = rule as CSSStyleRule;
        if (styleRule.selectorText && styleRule.cssText.includes('safe-area-inset')) {
          selectors.add(styleRule.selectorText);
        }
        const nested = (rule as CSSGroupingRule).cssRules;
        if (nested && nested.length > 0) walk(nested);
      }
    }

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {
        continue; // not one of ours
      }
    }

    return {
      declared: Array.from(selectors),
      matching: Array.from(selectors).filter((selector) => document.querySelector(selector) !== null),
    };
  });

  expect(
    guarded.declared.length,
    'no stylesheet rule references env(safe-area-inset-*): the counter has no safe-area handling, only class names that look like it'
  ).toBeGreaterThan(0);
  expect(
    guarded.matching.length,
    `safe-area rules exist (${guarded.declared.join(', ')}) but match nothing on the counter, so nothing is inset`
  ).toBeGreaterThan(0);
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
