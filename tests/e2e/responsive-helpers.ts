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
 * Applied on touch viewports only: a desktop pointer is precise, and
 * inflating a dense desktop table is not this phase's business.
 */
export async function assertTouchTargets(page: Page, label: string): Promise<void> {
  if (!isTouchViewport(page)) return;

  const tooSmall = await page.evaluate((minimum) => {
    const selector = 'button, a[href], select, [role="button"]';
    return Array.from(document.querySelectorAll(selector))
      .filter((el) => el.getAttribute('aria-hidden') !== 'true')
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.height < minimum - 0.5 || rect.width < minimum - 0.5;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 40) || el.getAttribute('aria-label') || '(no label)',
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
  }, MIN_TOUCH_TARGET_PX);

  expect(
    tooSmall,
    `${label}: ${tooSmall.length} control(s) smaller than ${MIN_TOUCH_TARGET_PX}×${MIN_TOUCH_TARGET_PX} on a touch viewport:\n${JSON.stringify(tooSmall, null, 2)}`
  ).toEqual([]);
}

/**
 * Text fields must compute to at least 16px on a phone.
 *
 * Below that, iOS Safari zooms the page on focus and never zooms back —
 * the operator ends up panning a magnified form with one hand.
 */
export async function assertFieldsDoNotTriggerIosZoom(page: Page, label: string): Promise<void> {
  if (!isPhoneViewport(page)) return;

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
