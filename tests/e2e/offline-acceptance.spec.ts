import { test, expect, Browser, Page, Route } from '@playwright/test';
import {
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  addInternalTransferCheckpoint,
  startEvent,
  beginClosingEvent,
  createDeviceInviteToken,
  getEventState,
  getEventDevices,
  AdminSession,
} from './helpers.js';
import { readOutbox, displayedOccupancy } from './offline-helpers.js';

const BATCH_URL = '**/api/v1/device/actions/batch';

interface Festival {
  eventId: string;
  externalSpaceId: string;
  siteSpaceId: string;
  vipSpaceId: string;
  mainCheckpointId: string;
  vipCheckpointId: string;
}

async function createFestival(session: AdminSession, name: string): Promise<Festival> {
  const topo = await createDraftEventWithMainCheckpoint(session, { name, capacity: 500 });
  const { zoneSpaceId, internalCheckpointId } = await addInternalTransferCheckpoint(session, topo, {
    zoneName: 'VIP',
    capacity: 50,
  });
  await startEvent(session, topo.eventId);
  return {
    eventId: topo.eventId,
    externalSpaceId: topo.externalSpaceId,
    siteSpaceId: topo.siteSpaceId,
    vipSpaceId: zoneSpaceId,
    mainCheckpointId: topo.mainCheckpointId,
    vipCheckpointId: internalCheckpointId,
  };
}

async function occupancies(session: AdminSession, eventId: string): Promise<Record<string, number>> {
  const state = await getEventState(session, eventId);
  return state.occupancy.spaces;
}

/** Opens a counter in its own browser context, i.e. as a distinct device. */
async function pairDevice(browser: Browser, token: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/pair#${token}`);
  await page.waitForURL('**/counter');
  await expect(page.locator('span.text-5xl.font-black')).toBeVisible();
  return page;
}

async function zoneValue(page: Page, testId: 'space-a-occupancy' | 'space-b-occupancy'): Promise<number> {
  const text = await page.getByTestId(testId).innerText();
  const match = text.match(/(-?\d+)\s*$/);
  return match ? Number(match[1]) : NaN;
}

async function waitForDrained(page: Page, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await readOutbox(page)).length === 0) return;
    await page.waitForTimeout(300);
  }
  expect(await readOutbox(page)).toHaveLength(0);
}

test.describe('Phase 6 — acceptation', () => {
  test('deux appareils hors ligne se drainent sans perte ni double application', async ({ browser }) => {
    test.setTimeout(180_000);

    const session = await getAdminSession();
    const festival = await createFestival(session, 'Festival Test — Acceptation');

    const sitePage = await pairDevice(
      browser,
      await createDeviceInviteToken(session, festival.eventId, festival.mainCheckpointId)
    );
    const vipPage = await pairDevice(
      browser,
      await createDeviceInviteToken(session, festival.eventId, festival.vipCheckpointId)
    );

    // --- Device Site: offline, three entries, one undo -----------------
    await sitePage.context().setOffline(true);

    for (let i = 0; i < 3; i++) {
      await sitePage.getByRole('button', { name: /ENTRÉE/ }).click();
    }
    await expect(sitePage.locator('span.text-5xl.font-black')).toHaveText('3');

    await sitePage.getByRole('button', { name: /ANNULER/ }).click();
    await expect(sitePage.locator('span.text-5xl.font-black')).toHaveText('2');

    // --- Device VIP: offline, one internal transfer --------------------
    await vipPage.context().setOffline(true);

    const globalBefore = await displayedOccupancy(vipPage);
    const siteBefore = await zoneValue(vipPage, 'space-a-occupancy');
    const vipBefore = await zoneValue(vipPage, 'space-b-occupancy');

    await vipPage.getByRole('button', { name: /→ VIP/ }).click();
    await vipPage.waitForTimeout(500);

    // A purely internal transfer moves one leaf's count into another's: the
    // global gauge must not budge, and the two zones must move by exactly
    // −1 and +1.
    expect(await displayedOccupancy(vipPage)).toBe(globalBefore);
    expect(await zoneValue(vipPage, 'space-a-occupancy')).toBe(siteBefore - 1);
    expect(await zoneValue(vipPage, 'space-b-occupancy')).toBe(vipBefore + 1);

    // --- The network comes back ---------------------------------------
    await sitePage.context().setOffline(false);
    await vipPage.context().setOffline(false);

    await waitForDrained(sitePage);
    await waitForDrained(vipPage);

    // Three entries minus one undo leaves +2 on Site; the VIP transfer then
    // moves one of them across. Nothing applied twice, nothing lost.
    const finalOccupancies = await occupancies(session, festival.eventId);
    expect(finalOccupancies[festival.siteSpaceId]).toBe(1);
    expect(finalOccupancies[festival.vipSpaceId]).toBe(1);
    expect((await getEventState(session, festival.eventId)).occupancy.global).toBe(2);

    // The authoritative state replaces the projection cleanly rather than
    // adding to it — a device that double-counted would show 3 or 4 here.
    await expect(sitePage.locator('span.text-5xl.font-black')).toHaveText('2', { timeout: 15_000 });
    await expect(vipPage.locator('span.text-5xl.font-black')).toHaveText('2', { timeout: 15_000 });

    // And it stays there: no oscillation between projection and truth.
    await sitePage.waitForTimeout(3_000);
    expect(await displayedOccupancy(sitePage)).toBe(2);
    expect(await displayedOccupancy(vipPage)).toBe(2);

    // Both devices report themselves fully drained to the supervisor.
    await expect(sitePage.getByText(/EN LIGNE/)).toBeVisible({ timeout: 20_000 });
    const devices = await getEventDevices(session, festival.eventId);
    expect(devices).toHaveLength(2);
    for (const device of devices) {
      expect(device.lastPendingCount).toBe(0);
    }

    await sitePage.context().close();
    await vipPage.context().close();
  });

  test('un comptage refusé bloque la synchronisation jusqu’à une reprise explicite', async ({ browser }) => {
    test.setTimeout(180_000);

    const session = await getAdminSession();
    const festival = await createFestival(session, 'Festival Test — Réconciliation');
    const page = await pairDevice(
      browser,
      await createDeviceInviteToken(session, festival.eventId, festival.mainCheckpointId)
    );

    // The topology is locked outside `draft` (a Phase 4 invariant), so no
    // genuinely fixable per-action refusal can be provoked against a live
    // event. The refusal is injected into the response instead: what is
    // under test here is the client's handling of a `rejected`
    // acknowledgment, and that part is exercised for real.
    let batchRequests = 0;
    const rejectAll = async (route: Route) => {
      batchRequests += 1;
      const response = await route.fetch();
      const body = await response.json();
      body.acknowledged = body.acknowledged.map((ack: { clientActionId: string }) => ({
        clientActionId: ack.clientActionId,
        status: 'rejected',
        errorCode: 'EVENT_NOT_LIVE',
      }));
      await route.fulfill({ response, body: JSON.stringify(body) });
    };
    await page.route(BATCH_URL, rejectAll);

    await page.getByRole('button', { name: /ENTRÉE/ }).click();

    // It surfaces as an explicit operational state, translated for the
    // operator, with no destructive "forget" affordance.
    await expect(page.getByText(/À RÉGULARISER \(1\)/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/n’a pas été accepté par le serveur/)).toBeVisible();
    await expect(page.getByText(/n’acceptait plus de comptage/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Oublier|Supprimer/i })).toHaveCount(0);

    // And it is not hammered at the server while it waits for a human.
    const afterFirstRound = batchRequests;
    await page.waitForTimeout(6_000);
    expect(batchRequests - afterFirstRound).toBeLessThanOrEqual(1);

    // It still counts as unresolved for the supervisor, so this device is
    // not drained and a normal `/close` must not pass.
    await expect
      .poll(
        async () => {
          const devices = await getEventDevices(session, festival.eventId);
          return devices[0]?.lastPendingCount;
        },
        { timeout: 25_000 }
      )
      .toBeGreaterThanOrEqual(1);

    // The cause is addressed, then the operator retries explicitly.
    await page.unroute(BATCH_URL, rejectAll);
    await page.getByRole('button', { name: /Réessayer/ }).click();

    await waitForDrained(page);
    await expect(page.getByText(/EN LIGNE/)).toBeVisible({ timeout: 15_000 });
    expect((await occupancies(session, festival.eventId))[festival.siteSpaceId]).toBe(1);

    await page.context().close();
  });

  test('closing draine les actions antérieures et refuse les nouvelles', async ({ browser }) => {
    test.setTimeout(180_000);

    const session = await getAdminSession();
    const festival = await createFestival(session, 'Festival Test — Closing');
    const page = await pairDevice(
      browser,
      await createDeviceInviteToken(session, festival.eventId, festival.mainCheckpointId)
    );

    // A tap made while the event is still live, with no network.
    await page.context().setOffline(true);
    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    await expect(page.locator('span.text-5xl.font-black')).toHaveText('1');
    expect(await readOutbox(page)).toHaveLength(1);

    // The supervisor begins closing while this device is still offline.
    await beginClosingEvent(session, festival.eventId);

    await page.context().setOffline(false);

    // The pre-closing action drains: `closing` is a drain window, not a wall.
    await waitForDrained(page);
    expect((await occupancies(session, festival.eventId))[festival.siteSpaceId]).toBe(1);

    // New taps are refused from here on.
    await expect(page.getByText(/Événement en cours de fermeture/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /ENTRÉE/ })).toBeDisabled();

    await page.getByRole('button', { name: /ENTRÉE/ }).click({ force: true });
    await page.waitForTimeout(1_000);
    expect(await readOutbox(page)).toHaveLength(0);

    // Unresolved only reaches zero once the server actually acknowledged,
    // which is what the closing gate reads.
    await expect
      .poll(
        async () => {
          const devices = await getEventDevices(session, festival.eventId);
          return devices[0]?.lastPendingCount;
        },
        { timeout: 25_000 }
      )
      .toBe(0);

    await page.context().close();
  });
});
