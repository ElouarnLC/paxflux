import { test, expect, Browser, Page } from '@playwright/test';
import {
  AdminSession,
  addInternalTransferCheckpoint,
  beginClosingEvent,
  completeDevicePairing,
  createDeviceInviteToken,
  createDraftEventWithMainCheckpoint,
  forceCloseEvent,
  getAdminSession,
  getEventDevices,
  getEventState,
  reopenEvent,
  startEvent,
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
  await completeDevicePairing(page, token);
  await expect(page.getByTestId('global-occupancy')).toBeVisible();
  return page;
}

async function zoneValue(page: Page, testId: 'space-a-occupancy' | 'space-b-occupancy'): Promise<number> {
  // Read from `data-occupancy` rather than off the end of the badge's text:
  // RC2-E appends a screen-reader sentence when the zone carries something
  // unacknowledged, and a trailing-number regex silently returned NaN for it.
  const raw = await page.getByTestId(testId).getAttribute('data-occupancy');
  return raw === null ? NaN : Number(raw);
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
    await expect(sitePage.getByTestId('global-occupancy')).toHaveText('3');

    await sitePage.getByRole('button', { name: /ANNULER/ }).click();
    await expect(sitePage.getByTestId('global-occupancy')).toHaveText('2');

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
    await expect(sitePage.getByTestId('global-occupancy')).toHaveText('2', { timeout: 15_000 });
    await expect(vipPage.getByTestId('global-occupancy')).toHaveText('2', { timeout: 15_000 });

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

    // The refusal below is the server's own. No acknowledgment is rewritten
    // anywhere in this test: a tap is made while the event is live and with
    // no network, the event is then closed for good, and the device
    // reconnects to a server that will not accept it.
    let batchRequests = 0;
    await page.route(BATCH_URL, async (route) => {
      batchRequests += 1;
      await route.continue();
    });

    await page.context().setOffline(true);
    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    await expect(page.getByTestId('global-occupancy')).toHaveText('1');

    await beginClosingEvent(session, festival.eventId);
    await forceCloseEvent(session, festival.eventId, 'Appareil hors ligne, fermeture forcée');
    await page.context().setOffline(false);

    // It surfaces as an explicit operational state, translated for the
    // operator, with no destructive "forget" affordance.
    await expect(page.getByText(/À RÉGULARISER \(1\)/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/n’a pas été accepté par le serveur/)).toBeVisible();
    await expect(page.getByText(/n’acceptait plus de comptage/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Oublier|Supprimer/i })).toHaveCount(0);

    expect((await readOutbox(page))[0].lastErrorCode).toBe('EVENT_NOT_LIVE');

    // A refusal the server pronounced is not occupancy: the gauge drops
    // back to the authoritative 0 rather than keeping the optimistic +1.
    await expect(page.getByTestId('global-occupancy')).toHaveText('0');

    // And it is not hammered at the server while it waits for a human.
    const afterFirstRound = batchRequests;
    await page.waitForTimeout(8_000);
    expect(batchRequests - afterFirstRound).toBe(0);

    // It still counts as unresolved for the supervisor, so this device is
    // not drained and a normal `/close` must not pass.
    await expect
      .poll(
        async () => {
          const devices = await getEventDevices(session, festival.eventId);
          return devices[0]?.lastPendingCount;
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThanOrEqual(1);

    // The cause is genuinely addressed — the event is reopened — and only
    // then does the operator's explicit retry resolve it.
    await reopenEvent(session, festival.eventId, 'Régularisation d’un comptage terrain');
    await page.getByRole('button', { name: /Réessayer/ }).click();

    await waitForDrained(page);
    await expect(page.getByText(/EN LIGNE/)).toBeVisible({ timeout: 20_000 });
    expect((await occupancies(session, festival.eventId))[festival.siteSpaceId]).toBe(1);
    await expect
      .poll(
        async () => {
          const devices = await getEventDevices(session, festival.eventId);
          return devices[0]?.lastPendingCount;
        },
        { timeout: 30_000 }
      )
      .toBe(0);

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
    await expect(page.getByTestId('global-occupancy')).toHaveText('1');
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
