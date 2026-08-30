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

  await page.goto('/admin/events/new');
  await assertNoHorizontalOverflow(page, '/admin/events/new (EventWizard)');

  await page.goto(`/pair#${token}`);
  await page.waitForURL('**/counter');
  await assertNoHorizontalOverflow(page, '/counter (CounterView)');
});
