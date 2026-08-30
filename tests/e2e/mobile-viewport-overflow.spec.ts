import { test, expect, Page } from '@playwright/test';
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  startEvent,
  createDeviceInviteToken,
} from './helpers.js';

async function assertNoHorizontalOverflow(page: Page, label: string) {
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
 * document.documentElement.scrollWidth alone can be gamed: slapping
 * `overflow-x: hidden` on the root or body clips scrollWidth back down to
 * the viewport width without fixing anything — the oversized layout is
 * still there, just visually cut off, and any interactive element caught
 * in it becomes partially or fully unreachable. This walks real
 * interactive elements and flags any whose bounding box actually extends
 * past the viewport, ignoring elements deliberately placed inside their
 * own horizontally-scrollable container (e.g. a table wrapped in
 * `overflow-x-auto`), where overflowing that container's box is by design.
 */
async function assertNoInteractiveElementOverflows(page: Page, label: string) {
  const overflowing = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const selector = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [tabindex]';

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
        return rect.width > 0 && rect.height > 0; // skip hidden/collapsed elements
      })
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.right > viewportWidth + 1 || rect.left < -1;
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

test('aucun overflow horizontal sur les écrans clés à ce viewport mobile', async ({ page }) => {
  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `Repro Mobile Overflow ${test.info().project.name}`,
    capacity: 30,
  });
  await startEvent(session, topo.eventId);
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
  await assertNoHorizontalOverflow(page, '/admin (Dashboard)');
  await assertNoInteractiveElementOverflows(page, '/admin (Dashboard)');

  await page.goto('/admin/events/new');
  await assertNoHorizontalOverflow(page, '/admin/events/new (EventWizard)');
  await assertNoInteractiveElementOverflows(page, '/admin/events/new (EventWizard)');

  await page.goto(`/pair#${token}`);
  await page.waitForURL('**/counter');
  await assertNoHorizontalOverflow(page, '/counter (CounterView)');
  await assertNoInteractiveElementOverflows(page, '/counter (CounterView)');
});
