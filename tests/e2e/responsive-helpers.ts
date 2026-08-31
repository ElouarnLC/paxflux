import { expect, Locator, Page } from '@playwright/test';

/**
 * Shared responsive assertions.
 *
 * Every one of them is written so that it cannot be satisfied by hiding the
 * problem. `document.scrollWidth` on its own is a weak signal — a single
 * `overflow-x: hidden` on the root clips it back to the viewport width
 * while the oversized layout, and any control stranded in it, is still
 * there. So the suite asserts three things together: the document does not
 * overflow, no interactive element sits outside the viewport, and the root
 * is not clipping horizontally in the first place.
 */

/** Below this width the UI is being used on a phone, one thumb at a time. */
export const PHONE_MAX_WIDTH = 767;
/** Up to and including this width the primary input is touch. */
export const TOUCH_MAX_WIDTH = 768;

/** Apple's and Google's shared minimum for a comfortable touch target. */
export const MIN_TOUCH_TARGET_PX = 44;

/** Below 16px, iOS Safari zooms the page in when a text field takes focus. */
export const MIN_MOBILE_FIELD_FONT_PX = 16;

export function viewportWidth(page: Page): number {
  const size = page.viewportSize();
  if (!size) throw new Error('This spec requires a fixed viewport; none is configured.');
  return size.width;
}

export function isPhoneViewport(page: Page): boolean {
  return viewportWidth(page) <= PHONE_MAX_WIDTH;
}

export function isTouchViewport(page: Page): boolean {
  return viewportWidth(page) <= TOUCH_MAX_WIDTH;
}

/** The document itself must never be wider than the viewport. */
export async function assertNoDocumentOverflow(page: Page, label: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  expect(
    scrollWidth,
    `${label}: document.documentElement.scrollWidth (${scrollWidth}) exceeds clientWidth (${clientWidth}) — horizontal overflow at this viewport`
  ).toBeLessThanOrEqual(clientWidth + 1);
}

/**
 * The root must not be clipping horizontally.
 *
 * This is the assertion that closes the cheat: with `overflow-x: hidden` on
 * `<html>`, `<body>` or the React root, `assertNoDocumentOverflow` passes on
 * a layout that is still broken. Requiring the clip to be absent means the
 * overflow assertion above is measuring the real layout.
 */
export async function assertRootDoesNotClipHorizontally(page: Page, label: string): Promise<void> {
  const clipping = await page.evaluate(() => {
    // A modal locks the page behind it: Radix sets `overflow: hidden` on
    // <body> for exactly as long as the dialog is open, so the frozen page
    // cannot be scrolled out from under it. That is the opposite of the
    // technique this assertion forbids — it is temporary, it is on both
    // axes, and it exists only while something owns the viewport. The
    // exemption is therefore conditional on a modal actually being open;
    // a stylesheet-level clip with no dialog on screen still fails.
    const modalOpen = document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
    if (modalOpen) return [];

    const roots: Array<{ name: string; el: Element | null }> = [
      { name: 'html', el: document.documentElement },
      { name: 'body', el: document.body },
      { name: '#root', el: document.getElementById('root') },
    ];
    return roots
      .filter((entry) => entry.el !== null)
      .map((entry) => ({ name: entry.name, overflowX: getComputedStyle(entry.el as Element).overflowX }))
      .filter((entry) => entry.overflowX === 'hidden' || entry.overflowX === 'clip');
  });

  expect(
    clipping,
    `${label}: the root is clipping horizontal overflow (${JSON.stringify(clipping)}). ` +
      `That hides the symptom instead of fixing the layout, and makes every scrollWidth assertion in this suite meaningless.`
  ).toEqual([]);
}

/**
 * Walks real interactive elements and flags any whose box actually extends
 * past the viewport.
 *
 * Elements deliberately placed inside their own horizontally-scrollable
 * container (a wide table in `overflow-x-auto`) are exempt: overflowing
 * *that* box is the design. Overflowing the document is not.
 */
export async function assertNoInteractiveElementOverflows(page: Page, label: string): Promise<void> {
  const overflowing = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const selector =
      'button, a[href], input, select, textarea, [role="button"], [role="link"], [tabindex]';

    function hasScrollableAncestor(el: Element): boolean {
      let node = el.parentElement;
      while (node) {
        const style = getComputedStyle(node);
        if (
          (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          node.scrollWidth > node.clientWidth
        ) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    }

    return Array.from(document.querySelectorAll(selector))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.right > viewport + 1 || rect.left < -1;
      })
      .filter((el) => !hasScrollableAncestor(el))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 40),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      });
  });

  expect(
    overflowing,
    `${label}: ${overflowing.length} interactive element(s) actually extend past the viewport (not inside a deliberate horizontal-scroll container):\n${JSON.stringify(overflowing, null, 2)}`
  ).toEqual([]);
}

/**
 * Text content must not spill past the viewport either.
 *
 * A long event name that pushes a card 80px wide of the screen breaks the
 * page even when every button happens to stay inside it, so leaf text nodes
 * are measured too.
 *
 * The exemption here is wider than the interactive one on purpose. Text may
 * legitimately be clipped — that is what `truncate` and `line-clamp` are —
 * provided the clipping container itself fits on screen. An interactive
 * element clipped that way would be unreachable, which is why the assertion
 * above exempts only genuinely scrollable ancestors. Neither exemption can
 * be used to fake success at the document level: the root is separately
 * forbidden from clipping at all, and a clipping ancestor only counts here
 * while its own box is inside the viewport.
 */
export async function assertNoTextOverflows(page: Page, label: string): Promise<void> {
  const overflowing = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;

    function hasScrollableAncestor(el: Element): boolean {
      let node = el.parentElement;
      while (node) {
        const style = getComputedStyle(node);
        const clips =
          style.overflowX === 'hidden' ||
          style.overflowX === 'clip' ||
          style.overflowY === 'hidden' ||
          style.overflowY === 'clip';
        const scrolls =
          (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          node.scrollWidth > node.clientWidth;
        if (scrolls) return true;
        if (clips) {
          const box = node.getBoundingClientRect();
          if (box.right <= viewport + 1 && box.left >= -1) return true;
        }
        node = node.parentElement;
      }
      return false;
    }

    return Array.from(document.querySelectorAll('body *'))
      .filter((el) => el.children.length === 0)
      .filter((el) => (el.textContent || '').trim().length > 0)
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.right > viewport + 1 || rect.left < -1;
      })
      .filter((el) => !hasScrollableAncestor(el))
      .slice(0, 12)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 48),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      });
  });

  expect(
    overflowing,
    `${label}: ${overflowing.length} text element(s) extend past the viewport:\n${JSON.stringify(overflowing, null, 2)}`
  ).toEqual([]);
}

/** The three overflow assertions that every screen must satisfy. */
export async function assertScreenFitsViewport(page: Page, label: string): Promise<void> {
  await assertRootDoesNotClipHorizontally(page, label);
  await assertNoDocumentOverflow(page, label);
  await assertNoInteractiveElementOverflows(page, label);
  await assertNoTextOverflows(page, label);
}

/**
 * Every visible control a thumb has to hit must be at least 44×44.
 *
 * The sweep covers form controls, not just buttons and links: a 20×20
 * checkbox is the hardest thing on any of these screens to hit, and leaving
 * `input` out of the selector was a hole this assertion claimed not to have.
 *
 * What is measured is the *effective activation target*, not the control's
 * own box. A checkbox is legitimately drawn at 20×20 as long as a <label>
 * around it (or pointing at it) gives the finger 44×44 to land on — that
 * label is what the browser dispatches the toggle from, so that is what the
 * assertion sizes.
 *
 * Applied on touch viewports only: a desktop pointer is precise, and
 * inflating a dense desktop table is not this phase's business.
 */
export async function assertTouchTargets(page: Page, label: string): Promise<void> {
  if (!isTouchViewport(page)) return;

  const tooSmall = await page.evaluate((minimum) => {
    const selector =
      'button, a[href], select, textarea, input, [role="button"], [role="checkbox"], [role="switch"]';

    /**
     * The box a tap actually has to land in: the control itself, or the
     * label that activates it when that label is bigger.
     */
    function activationTarget(el: Element): DOMRect {
      let best = el.getBoundingClientRect();

      const labels = (el as HTMLInputElement).labels;
      if (labels) {
        for (const owner of Array.from(labels)) {
          const rect = owner.getBoundingClientRect();
          if (rect.width * rect.height > best.width * best.height) best = rect;
        }
      }
      return best;
    }

    return Array.from(document.querySelectorAll(selector))
      .filter((el) => el.getAttribute('aria-hidden') !== 'true')
      .filter((el) => {
        if (el.tagName !== 'INPUT') return true;
        // A hidden or file-less input has no target to speak of.
        return (el as HTMLInputElement).type !== 'hidden';
      })
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((el) => ({ el, target: activationTarget(el) }))
      .filter(({ target }) => target.height < minimum - 0.5 || target.width < minimum - 0.5)
      .map(({ el, target }) => ({
        tag: el.tagName.toLowerCase() + (el.tagName === 'INPUT' ? `[${(el as HTMLInputElement).type}]` : ''),
        text:
          (el.textContent || '').trim().slice(0, 40) ||
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          '(no label)',
        width: Math.round(target.width),
        height: Math.round(target.height),
      }));
  }, MIN_TOUCH_TARGET_PX);

  expect(
    tooSmall,
    `${label}: ${tooSmall.length} control(s) whose effective tap target is smaller than ${MIN_TOUCH_TARGET_PX}×${MIN_TOUCH_TARGET_PX} on a touch viewport:\n${JSON.stringify(tooSmall, null, 2)}`
  ).toEqual([]);
}

/**
 * Text fields must compute to at least 16px on any touch viewport.
 *
 * Below that, iOS Safari zooms the page on focus and never zooms back — the
 * operator ends up panning a magnified form with one hand. The threshold
 * covers the 768px tablet too, which is why the fields step back down at
 * `lg` rather than `md`: a tablet is a touch device, not a desktop.
 */
export async function assertFieldsDoNotTriggerIosZoom(page: Page, label: string): Promise<void> {
  if (!isTouchViewport(page)) return;

  const tooSmall = await page.evaluate((minimum) => {
    const textualInputTypes = new Set([
      'text',
      'password',
      'email',
      'number',
      'search',
      'tel',
      'url',
      'date',
      'datetime-local',
      'time',
      '',
    ]);

    return Array.from(document.querySelectorAll('input, select, textarea'))
      .filter((el) => {
        if (el.tagName === 'INPUT') {
          const type = (el as HTMLInputElement).type.toLowerCase();
          return textualInputTypes.has(type);
        }
        return true;
      })
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((el) => ({ el, fontSize: parseFloat(getComputedStyle(el).fontSize) }))
      .filter((entry) => entry.fontSize < minimum - 0.01)
      .map((entry) => ({
        tag: entry.el.tagName.toLowerCase(),
        label: entry.el.getAttribute('aria-label') || entry.el.getAttribute('placeholder') || '(unlabelled)',
        fontSize: entry.fontSize,
      }));
  }, MIN_MOBILE_FIELD_FONT_PX);

  expect(
    tooSmall,
    `${label}: ${tooSmall.length} field(s) below ${MIN_MOBILE_FIELD_FONT_PX}px on a phone viewport — iOS will zoom the page on focus:\n${JSON.stringify(tooSmall, null, 2)}`
  ).toEqual([]);
}

/**
 * A control that takes keyboard focus must show it.
 *
 * `focus:outline-none` with nothing in its place makes the interface
 * unusable by keyboard, so this asserts a *perceptible* indicator: a real
 * outline, or a ring drawn with box-shadow.
 */
export async function assertVisibleFocusIndicator(
  page: Page,
  target: Locator,
  label: string
): Promise<void> {
  await target.focus();

  const indicator = await target.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth) || 0,
      boxShadow: style.boxShadow,
    };
  });

  const hasOutline = indicator.outlineStyle !== 'none' && indicator.outlineWidth > 0;
  const hasRing = indicator.boxShadow !== 'none' && indicator.boxShadow.trim().length > 0;

  expect(
    hasOutline || hasRing,
    `${label}: the focused control shows no perceptible keyboard indicator (${JSON.stringify(indicator)})`
  ).toBe(true);
}

/** No vertical scrolling either — used where a screen must fit in one view. */
export async function assertNoVerticalScrolling(page: Page, label: string): Promise<void> {
  const { scrollHeight, clientHeight } = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));

  expect(
    scrollHeight,
    `${label}: the page scrolls vertically (scrollHeight ${scrollHeight} > clientHeight ${clientHeight})`
  ).toBeLessThanOrEqual(clientHeight + 1);
}

/** An element is fully inside the viewport, both axes. */
export async function assertFullyVisible(page: Page, target: Locator, label: string): Promise<void> {
  const box = await target.boundingBox();
  const size = page.viewportSize();
  if (!size) throw new Error('This spec requires a fixed viewport; none is configured.');

  expect(box, `${label}: element has no box at all`).not.toBeNull();
  const rect = box!;

  expect(
    rect.y >= -1 && rect.y + rect.height <= size.height + 1,
    `${label}: element is not vertically inside the ${size.width}×${size.height} viewport (top ${Math.round(rect.y)}, bottom ${Math.round(rect.y + rect.height)})`
  ).toBe(true);

  expect(
    rect.x >= -1 && rect.x + rect.width <= size.width + 1,
    `${label}: element is not horizontally inside the ${size.width}×${size.height} viewport (left ${Math.round(rect.x)}, right ${Math.round(rect.x + rect.width)})`
  ).toBe(true);
}

/**
 * The routed page fills at least the visible viewport, and keeps whatever
 * vertical centring it was written with.
 *
 * This is the top-level height contract: #root establishes the dynamic
 * viewport height once and each route claims it with `flex-1`. The failure
 * it guards against is silent — a route that asks for `min-height: 100%`
 * against a parent with no definite height simply collapses to its content
 * and rides at the top of the screen, with no overflow, no error and no
 * visual clue beyond "the card is not where it used to be".
 *
 * `expectsCentring` says whether the page was written to centre its content;
 * the check only applies while that content is short enough for centring to
 * mean anything, since a card taller than the screen can only start at the
 * top and scroll.
 */
export async function assertShellFillsViewport(
  page: Page,
  label: string,
  opts: { expectsCentring?: boolean } = {}
): Promise<void> {
  const size = page.viewportSize();
  if (!size) throw new Error('This spec requires a fixed viewport; none is configured.');

  const measured = await page.evaluate(() => {
    const shell = document.querySelector('#root > *');
    if (!shell) return null;
    const card = shell.firstElementChild;
    const shellRect = shell.getBoundingClientRect();
    const cardRect = card ? card.getBoundingClientRect() : null;
    return {
      shellHeight: shellRect.height,
      card: cardRect ? { top: cardRect.top, height: cardRect.height } : null,
    };
  });

  expect(measured, `${label}: no routed element under #root at all`).not.toBeNull();
  const { shellHeight, card } = measured!;

  expect(
    Math.round(shellHeight),
    `${label}: the routed page is ${Math.round(shellHeight)}px tall in a ${size.height}px viewport — ` +
      `it is not filling the screen, so its background stops short and anything it centres sits high`
  ).toBeGreaterThanOrEqual(size.height - 1);

  if (!opts.expectsCentring || card === null) return;

  // Centring is only meaningful while the content fits; past that the page
  // legitimately starts at the top and scrolls.
  if (card.height > size.height) return;

  const cardCentre = card.top + card.height / 2;
  const viewportCentre = size.height / 2;
  expect(
    Math.abs(cardCentre - viewportCentre),
    `${label}: the centred content sits at y=${Math.round(cardCentre)} in a ${size.height}px viewport ` +
      `(centre ${Math.round(viewportCentre)}) — the page is no longer centring it vertically`
  ).toBeLessThanOrEqual(2);
}

/**
 * The safe-area contract, as stated in `apps/web/src/styles/index.css`.
 *
 * `viewport-fit=cover` lets the page paint into the display cutout, which is
 * a promise the CSS has to keep. Before this contract a `pb-safe` class name
 * existed with no rule behind it: it read like safe-area handling and did
 * nothing at all.
 *
 * Three things are asserted, because each of the three ways of getting it
 * wrong is invisible in a browser with no cutout:
 *
 *  - an inset rule exists *and reaches an element* — a rule matching nothing
 *    protects nothing;
 *  - it reaches exactly `#root` — a second inset on a descendant is counted
 *    twice, pushing content further in on every device that has a notch;
 *  - every `position: sticky` element takes its `top` from a rule that
 *    consults the inset. A sticky element offsets from the scrollport, not
 *    from `#root`, so at `top: 0` it slides under the status bar as soon as
 *    the page scrolls. With no cutout here both spellings compute to `0px`,
 *    so the computed value cannot tell them apart — the matching rule can.
 */
export async function assertSafeAreaContract(page: Page, label: string): Promise<void> {
  const insets = await page.evaluate(() => {
    const paddingRules: Array<{ selector: string; matches: string[] }> = [];
    const offsetRules: string[] = [];

    function describe(el: Element): string {
      return el.id ? `#${el.id}` : el.tagName.toLowerCase();
    }

    // Tailwind emits inside `@layer` blocks, and modern Chrome exposes
    // `cssRules` on plain style rules too (nested CSS), so every rule is
    // both visited and descended into.
    function walk(rules: CSSRuleList) {
      for (const rule of Array.from(rules)) {
        const styleRule = rule as CSSStyleRule;
        const selector = styleRule.selectorText;
        if (selector && styleRule.style) {
          const declaration = styleRule.style.cssText;
          if (declaration.includes('safe-area-inset')) {
            if (/padding/.test(declaration)) {
              paddingRules.push({
                selector,
                matches: Array.from(document.querySelectorAll(selector)).map(describe),
              });
            }
            if (/(^|[^-])top:/.test(declaration)) offsetRules.push(selector);
          }
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

    const stickyElements = Array.from(document.querySelectorAll('*'))
      .filter((el) => getComputedStyle(el).position === 'sticky')
      .map((el) => ({
        tag: describe(el),
        safeOffset: offsetRules.some((selector) => el.matches(selector)),
      }));

    return { paddingRules, stickyElements };
  });

  const insetElements = insets.paddingRules.flatMap((rule) => rule.matches);

  expect(
    insetElements.length,
    `${label}: no rule referencing env(safe-area-inset-*) matches anything on this screen — the app declares viewport-fit=cover and then insets nothing`
  ).toBeGreaterThan(0);

  expect(
    insetElements,
    `${label}: the device insets reach more than #root (${JSON.stringify(insets.paddingRules)}); a second inset on a descendant is counted twice`
  ).toEqual(['#root']);

  expect(
    insets.stickyElements.filter((el) => !el.safeOffset),
    `${label}: sticky element(s) offset from the scrollport without clearing the status bar: ${JSON.stringify(insets.stickyElements)}`
  ).toEqual([]);
}

/**
 * The portal half of the safe-area contract.
 *
 * A Radix Dialog renders into <body>, outside #root, so it inherits none of
 * `.safe-area-root`'s padding. That makes it the one place where applying
 * the insets a second time is correct rather than doubled — and the one
 * place where forgetting them puts a confirmation button under the home
 * indicator.
 *
 * With no cutout in this browser every inset resolves to 0, so no measured
 * geometry can tell a correct implementation from a missing one. What can:
 * the rule that matches the open panel must consult
 * `env(safe-area-inset-*)`, and it must budget its height in `dvh` rather
 * than assuming a fixed viewport.
 */
export async function assertPortalSafeArea(page: Page, label: string): Promise<void> {
  const found = await page.evaluate(() => {
    const panel =
      document.querySelector('[role="alertdialog"]') || document.querySelector('[role="dialog"]');
    if (!panel) return null;

    const matching: Array<{ selector: string; declaration: string }> = [];

    function walk(rules: CSSRuleList) {
      for (const rule of Array.from(rules)) {
        const styleRule = rule as CSSStyleRule;
        if (
          styleRule.selectorText &&
          styleRule.cssText.includes('safe-area-inset') &&
          panel!.matches(styleRule.selectorText)
        ) {
          matching.push({ selector: styleRule.selectorText, declaration: styleRule.style.cssText });
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
      matching,
      usesDynamicViewport: matching.some((m) => /\d+dvh/.test(m.declaration)),
      overflowY: getComputedStyle(panel).overflowY,
    };
  });

  expect(found, `${label}: no dialog is open, so this assertion would be vacuous`).not.toBeNull();

  expect(
    found!.matching.length,
    `${label}: the portalled dialog is matched by no rule consulting env(safe-area-inset-*) — outside #root, it is inset by nothing`
  ).toBeGreaterThan(0);

  expect(
    found!.usesDynamicViewport,
    `${label}: the dialog's height budget does not use dvh (${JSON.stringify(found!.matching)}), so it assumes a viewport the browser chrome does not leave it`
  ).toBe(true);
}

/** WCAG 2.1 SC 1.4.3: 18pt, or 14pt bold, counts as "large text". */
export const LARGE_TEXT_PX = 24;
export const LARGE_TEXT_BOLD_PX = 18.66;
export const LARGE_TEXT_MIN_WEIGHT = 700;

/**
 * Measures the contrast of **every** piece of text under `root`, at the
 * threshold its own size and weight earn it.
 *
 * This exists because of a specific mistake, and its shape is the fix for
 * that mistake. The count buttons were audited as "large text, 3:1" and
 * signed off at 4.30:1 — but each button carries *two* labels, and the
 * second one ("Vers …") is 12px medium, i.e. small text at 4.5:1. Worse, it
 * was drawn at 80% opacity, which is a contrast reduction that never
 * appears in a token table: the token said 4.30:1, the pixels said 3.32:1.
 *
 * So this assertion cannot be satisfied by checking the headline. It
 * enumerates every element with its own text, derives the threshold from
 * the computed font-size and weight, and composites the alpha of both the
 * foreground and every background layer above it — using the browser's own
 * colour pipeline via a canvas, so `oklch()`, `color-mix()` and nested
 * translucent surfaces all resolve exactly as they are painted.
 */
export async function assertTextContrast(
  page: Page,
  rootSelector: string,
  label: string
): Promise<void> {
  const findings = await page.evaluate(
    ({ rootSelector, largePx, largeBoldPx, largeWeight }) => {
      const root = document.querySelector(rootSelector);
      if (!root) return null;

      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

      /** Paints `css` over `backdrop` and reads back what the browser drew. */
      function paint(css: string, backdrop: [number, number, number]): [number, number, number] {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = `rgb(${backdrop.map((c) => Math.round(c * 255)).join(',')})`;
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0] / 255, d[1] / 255, d[2] / 255];
      }

      /** Every background layer from the canvas down to this element. */
      function effectiveBackground(el: Element): [number, number, number] {
        const layers: string[] = [];
        let node: Element | null = el;
        while (node) {
          layers.unshift(getComputedStyle(node).backgroundColor);
          node = node.parentElement;
        }
        let acc: [number, number, number] = [1, 1, 1]; // the UA canvas
        for (const layer of layers) acc = paint(layer, acc);
        return acc;
      }

      const decode = (u: number) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
      function relLum([r, g, b]: [number, number, number]) {
        return 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b);
      }
      function contrastOf(a: [number, number, number], b: [number, number, number]) {
        const la = relLum(a);
        const lb = relLum(b);
        const [hi, lo] = la > lb ? [la, lb] : [lb, la];
        return (hi + 0.05) / (lo + 0.05);
      }

      const measured: Array<{
        tag: string;
        text: string;
        fontPx: number;
        weight: number;
        large: boolean;
        ratio: number;
        threshold: number;
      }> = [];

      for (const el of Array.from(root.querySelectorAll('*'))) {
        // Only elements holding their own text: a wrapper inherits its
        // children's words and would be counted twice.
        const ownText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent || '').trim())
          .join(' ')
          .trim();
        if (!ownText) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.opacity === '0') continue;

        const fontPx = parseFloat(style.fontSize);
        const weight = parseInt(style.fontWeight, 10) || 400;
        const large = fontPx >= largePx || (fontPx >= largeBoldPx && weight >= largeWeight);

        const bg = effectiveBackground(el.parentElement || el);
        const fg = paint(style.color, bg);
        const ratio = contrastOf(fg, bg);

        measured.push({
          tag: el.tagName.toLowerCase(),
          text: ownText.slice(0, 44),
          fontPx: Math.round(fontPx * 100) / 100,
          weight,
          large,
          ratio: Math.round(ratio * 100) / 100,
          threshold: large ? 3 : 4.5,
        });
      }

      return measured;
    },
    {
      rootSelector,
      largePx: LARGE_TEXT_PX,
      largeBoldPx: LARGE_TEXT_BOLD_PX,
      largeWeight: LARGE_TEXT_MIN_WEIGHT,
    }
  );

  expect(findings, `${label}: "${rootSelector}" matched nothing, so this would be vacuous`).not.toBeNull();
  const measured = findings!;

  expect(
    measured.length,
    `${label}: no text found under "${rootSelector}" — the assertion would prove nothing`
  ).toBeGreaterThan(0);

  // The hole this guard closes: an audit that only ever looked at headlines
  // would pass while a small label failed. If nothing small is on screen,
  // the run is not evidence.
  expect(
    measured.filter((m) => !m.large).length,
    `${label}: only large text was measured, which is exactly the blind spot this assertion exists to remove`
  ).toBeGreaterThan(0);

  const failing = measured.filter((m) => m.ratio < m.threshold - 0.005);
  expect(
    failing,
    `${label}: ${failing.length} text element(s) below their WCAG 1.4.3 threshold:\n${JSON.stringify(failing, null, 2)}`
  ).toEqual([]);
}
