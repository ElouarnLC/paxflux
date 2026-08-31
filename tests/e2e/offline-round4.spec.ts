import { test, expect, Page, Route } from '@playwright/test';
import {
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  startEvent,
  beginClosingEvent,
  tryCloseEvent,
  forceCloseEvent,
  reopenEvent,
  createDeviceInviteToken,
  getEventState,
  getEventDevices,
  AdminSession,
} from './helpers.js';
import { readOutbox, readDeviceConfigRecord, StoredOutboxRow } from './offline-helpers.js';

const BATCH_URL = '**/api/v1/device/actions/batch';
const HEARTBEAT_URL = '**/api/v1/device/heartbeat';
const BOOTSTRAP_URL = '**/api/v1/device/bootstrap';

async function spaceOccupancy(session: AdminSession, eventId: string, spaceId: string): Promise<number> {
  const state = await getEventState(session, eventId);
  const occupancies: Record<string, number> = state.occupancy.spaces;
  return occupancies[spaceId] ?? 0;
}

async function waitForOutbox(
  page: Page,
  predicate: (rows: StoredOutboxRow[]) => boolean,
  timeoutMs = 25_000
): Promise<StoredOutboxRow[]> {
  const start = Date.now();
  let rows: StoredOutboxRow[] = [];
  while (Date.now() - start < timeoutMs) {
    rows = await readOutbox(page);
    if (predicate(rows)) return rows;
    await page.waitForTimeout(250);
  }
  return rows;
}

test.describe('Phase 6 round 4 — époque de fermeture et identité tardive', () => {
  test('une fermeture normale exige une confirmation de drain liée à l’époque closing', async ({ page }) => {
    test.setTimeout(180_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round4 Closing Epoch',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');

    // The device is freshly online and the server knows it as fully drained.
    await expect
      .poll(
        async () => {
          const devices = await getEventDevices(session, topo.eventId);
          return devices[0]?.lastPendingCount;
        },
        { timeout: 25_000 }
      )
      .toBe(0);

    // It then goes dark — nothing it does from here reaches the server —
    // and makes a real count while the event is still live.
    const blockDeviceReports = (route: Route) => route.abort('failed');
    await page.route(BATCH_URL, blockDeviceReports);
    await page.route(HEARTBEAT_URL, blockDeviceReports);

    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    const queued = await waitForOutbox(page, (rows) => rows.length === 1);
    expect(queued).toHaveLength(1);

    // The supervisor begins closing and immediately tries a normal close.
    // The server's last word from this device is "online, nothing pending",
    // which was true before the tap and says nothing about the epoch that
    // has just begun.
    await beginClosingEvent(session, topo.eventId);
    const refused = await tryCloseEvent(session, topo.eventId);

    expect(refused.status).toBe(409);
    expect((refused.body as { code?: string }).code).toBe('DEVICES_NOT_SYNCED');

    // Nothing was lost by the refusal: the count is still queued.
    expect(await readOutbox(page)).toHaveLength(1);

    // The device comes back, learns the event is closing, and drains what
    // it made before the transition.
    await page.unroute(BATCH_URL, blockDeviceReports);
    await page.unroute(HEARTBEAT_URL, blockDeviceReports);

    await expect(page.getByText(/Événement en cours de fermeture/)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole('button', { name: /ENTRÉE/ })).toBeDisabled();
    await waitForOutbox(page, (rows) => rows.length === 0);
    await expect
      .poll(async () => spaceOccupancy(session, topo.eventId, topo.siteSpaceId), { timeout: 30_000 })
      .toBe(1);

    // Only once the device has acknowledged *this* closing epoch with
    // nothing unresolved does the normal close go through.
    await expect
      .poll(async () => (await tryCloseEvent(session, topo.eventId)).status, { timeout: 40_000 })
      .toBe(200);
  });

  test('une réponse bootstrap A en vol ne ressuscite jamais l’identité A après un appairage B', async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round4 Late Bootstrap',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);

    const tokenA = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
    const tokenB = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${tokenA}`);
    await page.waitForURL('**/counter');

    // A second tab whose bootstrap request is answered by the server for
    // real — as device A — but whose response is held on the way back.
    let releaseHeldBootstrap: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      releaseHeldBootstrap = resolve;
    });
    let captured: (() => void) | null = null;
    const capturedA = new Promise<void>((resolve) => {
      captured = resolve;
    });

    const holdBootstrapForA = async (route: Route) => {
      const response = await route.fetch();
      const body = await response.text();
      captured?.();
      await held;
      await route.fulfill({ response, body });
    };
    const secondTab = await context.newPage();
    await secondTab.route(BOOTSTRAP_URL, holdBootstrapForA);
    await secondTab.goto('/counter');

    // The response really was A's: it left the server before B existed.
    await capturedA;

    // Now B pairs, in the first tab, and its own bootstrap never arrives.
    const failBootstrap = (route: Route) => route.abort('failed');
    await page.route(BOOTSTRAP_URL, failBootstrap);
    const pairResponse = page.waitForResponse(
      (response) => response.url().includes('/api/v1/device/pair') && response.status() === 200,
      { timeout: 30_000 }
    );
    await page.goto(`/pair#${tokenB}`);
    const sessionBId = (await (await pairResponse).json()).deviceSession.id as string;
    await page.waitForURL('**/counter', { timeout: 30_000 });

    await expect
      .poll(async () => (await readDeviceConfigRecord(page))?.pendingSessionId, { timeout: 25_000 })
      .toBe(sessionBId);

    // Release A's response. It is a genuine, well-formed bootstrap — for an
    // identity this device has retired. Committing it would undo the
    // handoff and put A back in charge under B's cookie.
    releaseHeldBootstrap?.();
    await secondTab.waitForTimeout(8_000);

    const config = await readDeviceConfigRecord(page);
    expect(config?.bootstrap).toBeUndefined();
    expect(config?.pendingSessionId).toBe(sessionBId);

    // Neither tab goes back to counting as A.
    await expect(secondTab.getByRole('button', { name: /ENTRÉE/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /ENTRÉE/ })).toHaveCount(0);
    await expect(page.getByText(/Appairage en cours — configuration en attente/)).toBeVisible();

    await secondTab.close();
  });

  test('un 409 de heartbeat sur l’identité de session arrête le comptage', async ({ page }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round4 Heartbeat Mismatch',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');
    await expect(page.getByRole('button', { name: /ENTRÉE/ })).toBeEnabled();

    // The server tells this device it is reporting as a session the cookie
    // no longer authenticates — a re-pairing whose configuration never
    // arrived. Continuing to count would build up taps under an identity
    // the server has already disowned.
    await page.route(HEARTBEAT_URL, async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 409,
          code: 'DEVICE_SESSION_MISMATCH',
          title: 'Session appareil différente',
          detail: 'Ce heartbeat concerne un autre appairage de cet appareil.',
        }),
      });
    });

    await expect(page.getByText(/RÉVOQUÉ/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /ENTRÉE/ })).toBeDisabled();
  });
});
