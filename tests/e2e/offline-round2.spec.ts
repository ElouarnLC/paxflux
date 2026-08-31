import { test, expect, Page, Route } from '@playwright/test';
import {
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  addInternalTransferCheckpoint,
  startEvent,
  beginClosingEvent,
  createDeviceInviteToken,
  getEventState,
  getEventDevices,
  revokeDeviceSession,
  AdminSession,
} from './helpers.js';
import {
  readOutbox,
  readEventStateRecord,
  seedLegacyV1Database,
  waitForServiceWorkerControl,
  StoredOutboxRow,
} from './offline-helpers.js';

const BATCH_URL = '**/api/v1/device/actions/batch';
const BOOTSTRAP_URL = '**/api/v1/device/bootstrap';

async function spaceOccupancy(session: AdminSession, eventId: string, spaceId: string): Promise<number> {
  const state = await getEventState(session, eventId);
  const occupancies: Record<string, number> = state.occupancy.spaces;
  return occupancies[spaceId] ?? 0;
}

async function waitForOutbox(
  page: Page,
  predicate: (rows: StoredOutboxRow[]) => boolean,
  timeoutMs = 20_000
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

test.describe('Phase 6 round 2 — identité, cycle de vie et erreurs de flush', () => {
  test('aucune action de A n’est appliquée comme B pendant la fenêtre de ré-appairage', async ({ page }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round2 Pairing Race',
      capacity: 200,
    });
    const { zoneSpaceId, internalCheckpointId } = await addInternalTransferCheckpoint(session, topo, {
      zoneName: 'VIP',
      capacity: 50,
    });
    await startEvent(session, topo.eventId);

    const tokenA = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
    const tokenB = await createDeviceInviteToken(session, topo.eventId, internalCheckpointId);

    await page.goto(`/pair#${tokenA}`);
    await page.waitForURL('**/counter');

    // A's tap is queued and cannot leave.
    const blockBatch = (route: Route) => route.abort('failed');
    await page.route(BATCH_URL, blockBatch);
    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    const queued = await waitForOutbox(page, (rows) => rows.length === 1);
    expect(queued).toHaveLength(1);
    const orphanId = queued[0].clientActionId;

    // Hold every bootstrap response for long enough that the re-pairing
    // leaves the browser holding B's cookie while the device's own stored
    // configuration still describes A. That is the window this test is
    // about, and it is not hypothetical: /pair sets the cookie, and the
    // configuration is only replaced once the bootstrap that follows it
    // comes back.
    let bootstrapCalls = 0;
    const delayBootstrap = async (route: Route) => {
      bootstrapCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      await route.continue();
    };
    await page.route(BOOTSTRAP_URL, delayBootstrap);

    // Navigate to B's pairing URL but do not wait for the counter: the
    // bootstrap it needs is being held.
    const navigation = page.goto(`/pair#${tokenB}`).catch(() => undefined);

    // Once /pair has answered, the cookie is B's. Release the batch
    // endpoint so the retry engine fires inside the window.
    await page.waitForResponse(
      (response) => response.url().includes('/api/v1/device/pair') && response.status() === 200,
      { timeout: 20_000 }
    );
    await page.unroute(BATCH_URL, blockBatch);
    await page.waitForTimeout(6_000);

    // Whatever the client believed, the server refused: the batch asserted
    // session A while the cookie authenticated B.
    expect(await spaceOccupancy(session, topo.eventId, zoneSpaceId)).toBe(0);
    expect(await spaceOccupancy(session, topo.eventId, topo.siteSpaceId)).toBe(0);
    expect(bootstrapCalls).toBeGreaterThan(0);

    // And A's count is kept, parked, never re-stamped as B's.
    const rows = await readOutbox(page);
    const orphan = rows.find((r) => r.clientActionId === orphanId);
    expect(orphan).toBeDefined();
    expect(orphan?.sendState).toBe('quarantined');
    expect(orphan?.owner?.checkpointId).toBe(topo.mainCheckpointId);

    await page.unroute(BOOTSTRAP_URL, delayBootstrap);
    await navigation;
  });

  test('une quarantaine d’un appairage précédent ne compte pas dans le pending de la nouvelle session', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round2 Owner Scoped Pending',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);

    const tokenA = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
    await page.goto(`/pair#${tokenA}`);
    await page.waitForURL('**/counter');

    const blockBatch = (route: Route) => route.abort('failed');
    await page.route(BATCH_URL, blockBatch);
    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    const queued = await waitForOutbox(page, (rows) => rows.length === 1);
    const orphanId = queued[0].clientActionId;

    // Re-pair as B on the same door, then let the queue settle.
    const tokenB = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
    await page.goto(`/pair#${tokenB}`);
    await page.waitForURL('**/counter');
    await page.unroute(BATCH_URL, blockBatch);

    const afterQuarantine = await waitForOutbox(
      page,
      (rows) => rows.find((r) => r.clientActionId === orphanId)?.sendState === 'quarantined'
    );
    expect(afterQuarantine.find((r) => r.clientActionId === orphanId)?.sendState).toBe('quarantined');

    // B does its own work and drains it. Wait for the counter to be
    // interactive first: a tap is refused until the pairing it belongs to
    // is loaded, which is exactly the guard the previous blocker added.
    await expect(page.getByRole('button', { name: /ENTRÉE/ })).toBeEnabled();
    await page.getByRole('button', { name: /ENTRÉE/ }).click();

    // Assert on the server, not on a local intermediate state: `sending` is
    // not drained, and an outbox that looks empty a moment after the click
    // may simply not have been written yet.
    await expect
      .poll(async () => spaceOccupancy(session, topo.eventId, topo.siteSpaceId), { timeout: 30_000 })
      .toBe(1);
    await expect.poll(async () => (await readOutbox(page)).length, { timeout: 30_000 }).toBe(1);

    // A's stranded count stays visible locally — it is a real reconciliation
    // problem — but it is not B's, and B must be able to report itself
    // drained so the event can be closed normally.
    const remaining = await readOutbox(page);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].clientActionId).toBe(orphanId);
    await expect
      .poll(
        async () => {
          const devices = await getEventDevices(session, topo.eventId);
          const deviceB = devices.find((d) => d.id !== undefined && d.lastSeenAtMs !== null);
          return deviceB?.lastPendingCount;
        },
        { timeout: 30_000 }
      )
      .toBe(0);

    // The whole point: closing is not blocked by a previous pairing's queue.
    await beginClosingEvent(session, topo.eventId);
    await expect
      .poll(
        async () => {
          const devices = await getEventDevices(session, topo.eventId);
          return devices.every((d) => d.lastPendingCount === 0);
        },
        { timeout: 30_000 }
      )
      .toBe(true);
  });

  test('une transition closing survit à un redémarrage sans réseau', async ({ page }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round2 Lifecycle Durable',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');
    await expect(page.getByRole('button', { name: /ENTRÉE/ })).toBeEnabled();

    await beginClosingEvent(session, topo.eventId);
    await expect(page.getByText(/Événement en cours de fermeture/)).toBeVisible({ timeout: 15_000 });

    // Restart with nothing reachable. A lifecycle transition does not bump
    // `event.version`, so a counter that re-derived its status from the last
    // stored state frame would come back believing the event is still live
    // and re-enable counting.
    await page.route('**/api/v1/**', (route) => route.abort('failed'));
    await page.reload();

    await expect(page.getByText(/Événement en cours de fermeture/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /ENTRÉE/ })).toBeDisabled();
  });

  test('une réponse batch antérieure au closing ne ressuscite pas l’état live', async ({ page }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round2 Lifecycle Stale Batch',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');

    // Hold a batch response minted while the event is still live.
    let released: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const holdBatch = async (route: Route) => {
      const response = await route.fetch();
      const body = await response.text();
      await gate;
      await route.fulfill({ response, body });
    };
    await page.route(BATCH_URL, holdBatch);

    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    // Give the request time to reach the server and be captured on the way back.
    await page.waitForTimeout(2_000);

    // The event moves on while that response is in flight.
    await beginClosingEvent(session, topo.eventId);
    await expect(page.getByText(/Événement en cours de fermeture/)).toBeVisible({ timeout: 15_000 });

    // Now let the stale `live` response land.
    released?.();
    await page.waitForTimeout(3_000);
    await page.unroute(BATCH_URL, holdBatch);

    // Restart offline: the persisted lifecycle marker carries a later
    // server timestamp than the state frame, so `closing` wins.
    await page.route('**/api/v1/**', (route) => route.abort('failed'));
    await page.reload();

    await expect(page.getByText(/Événement en cours de fermeture/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /ENTRÉE/ })).toBeDisabled();
  });

  test('un comptage confirmé par le serveur reste annulable', async ({ page }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round2 Confirmed Undo',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');

    // A perfectly ordinary online tap: acknowledged and gone from the outbox
    // within a second.
    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    await expect
      .poll(async () => spaceOccupancy(session, topo.eventId, topo.siteSpaceId), { timeout: 30_000 })
      .toBe(1);
    await waitForOutbox(page, (rows) => rows.length === 0);
    await expect(page.locator('span.text-5xl.font-black')).toHaveText('1');

    // SPEC §11.2: the operator can still take it back. Before this, the
    // acknowledgment that removed the action also removed the undo.
    const undo = page.getByRole('button', { name: /ANNULER/ });
    await expect(undo).toBeVisible();
    await undo.click();

    await expect
      .poll(async () => spaceOccupancy(session, topo.eventId, topo.siteSpaceId), { timeout: 30_000 })
      .toBe(0);
    await waitForOutbox(page, (rows) => rows.length === 0);
    await expect(page.locator('span.text-5xl.font-black')).toHaveText('0', { timeout: 15_000 });

    // And exactly once: the gauge settles at 0 rather than oscillating.
    await page.waitForTimeout(3_000);
    await expect(page.locator('span.text-5xl.font-black')).toHaveText('0');
    expect(await readOutbox(page)).toHaveLength(0);
  });

  test('un 200 au corps illisible est traité comme un ACK incertain, pas comme un succès', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round2 Invalid 200',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');

    // The server applies the movement; the response is truncated on the way
    // back. The action's fate is genuinely unknown to the client.
    let truncatedResponses = 0;
    const truncate = async (route: Route) => {
      const response = await route.fetch();
      const body = await response.text();
      truncatedResponses += 1;
      await route.fulfill({
        response,
        body: body.slice(0, Math.max(1, Math.floor(body.length / 2))),
      });
    };
    await page.route(BATCH_URL, truncate);

    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    await page.waitForTimeout(3_000);
    expect(truncatedResponses).toBeGreaterThan(0);

    // It must not have been deleted (that would lose a count whose fate is
    // unknown) and must not be parked as refused (nothing refused it): it
    // stays retryable.
    const midFlight = await readOutbox(page);
    expect(midFlight).toHaveLength(1);
    expect(midFlight[0].sendState).toBe('pending');
    expect(midFlight[0].lastErrorCode).toBe('INVALID_BATCH_RESPONSE');

    // With the response readable again, the retry resolves it — as a
    // duplicate, since the server had applied it all along, so the count
    // lands exactly once.
    await page.unroute(BATCH_URL, truncate);
    await waitForOutbox(page, (rows) => rows.length === 0);
    await expect
      .poll(async () => spaceOccupancy(session, topo.eventId, topo.siteSpaceId), { timeout: 30_000 })
      .toBe(1);
  });

  test('un 401 appareil est terminal : plus aucun renvoi automatique', async ({ page }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round2 Revoked Batch',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');

    const devices = await getEventDevices(session, topo.eventId);
    const deviceSessionId = devices[0].id;

    // Queue a tap that cannot leave, then pull the device's session.
    const blockBatch = (route: Route) => route.abort('failed');
    await page.route(BATCH_URL, blockBatch);
    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    await waitForOutbox(page, (rows) => rows.length === 1);

    await revokeDeviceSession(session, deviceSessionId);

    let batchRequests = 0;
    await page.unroute(BATCH_URL, blockBatch);
    await page.route(BATCH_URL, async (route) => {
      batchRequests += 1;
      await route.continue();
    });

    await expect
      .poll(async () => (await readOutbox(page))[0]?.sendState, { timeout: 25_000 })
      .toBe('quarantined');

    const rows = await readOutbox(page);
    expect(rows[0].lastErrorCode).toBe('DEVICE_SESSION_INVALID');

    // A revoked session used to be retried every few seconds, forever.
    const afterFirstRefusal = batchRequests;
    await page.waitForTimeout(10_000);
    expect(batchRequests - afterFirstRefusal).toBe(0);

    // The count is kept, and surfaced for reconciliation rather than lost.
    expect(await readOutbox(page)).toHaveLength(1);
    await expect(page.getByText(/À RÉGULARISER|RÉVOQUÉ/)).toBeVisible({ timeout: 10_000 });
  });

  test('un état legacy d’un autre événement n’est jamais attribué au nouvel appairage', async ({ page }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();

    // Event A: an older pairing whose cached state carries a high version.
    const eventA = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round2 Legacy Event A',
      capacity: 200,
    });
    // Event B: the pairing this device is about to have, newer in time but
    // starting from version 0.
    const eventB = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round2 Legacy Event B',
      capacity: 200,
    });
    await startEvent(session, eventB.eventId);
    const tokenB = await createDeviceInviteToken(session, eventB.eventId, eventB.mainCheckpointId);

    const bootstrapB = {
      event: { id: eventB.eventId, name: 'Round2 Legacy Event B', status: 'live', capacity: 200 },
      checkpoint: {
        id: eventB.mainCheckpointId,
        name: 'Porte Principale',
        spaceAId: eventB.externalSpaceId,
        spaceBId: eventB.siteSpaceId,
        spaceAName: 'Extérieur',
        spaceBName: 'Site',
        labelAToB: 'ENTRÉE +1',
        labelBToA: 'SORTIE −1',
        allowAToB: true,
        allowBToA: true,
      },
      deviceSession: { id: '00000000-0000-4000-8000-000000000001', label: 'Legacy' },
      state: {
        version: 1,
        eventStatus: 'live',
        eventOccupancy: 0,
        eventCapacity: 200,
        spaces: [
          { id: eventB.externalSpaceId, name: 'Extérieur', kind: 'external', occupancy: 0, capacity: null },
          { id: eventB.siteSpaceId, name: 'Site', kind: 'leaf', occupancy: 0, capacity: 200 },
        ],
        serverTimeMs: Date.now(),
      },
    };

    // The stale cache: event A's state, far ahead in version, with no event
    // id attached anywhere — exactly what the v1 schema stored.
    const staleStateOfA = {
      version: 999,
      eventStatus: 'live',
      eventOccupancy: 250,
      eventCapacity: 200,
      spaces: [
        { id: eventA.externalSpaceId, name: 'Extérieur', kind: 'external', occupancy: 0, capacity: null },
        { id: eventA.siteSpaceId, name: 'Site', kind: 'leaf', occupancy: 250, capacity: 200 },
      ],
      serverTimeMs: Date.now() - 86_400_000,
    };

    await page.goto('/health/live');
    await seedLegacyV1Database(
      page,
      [],
      [
        { key: 'bootstrap_config', bootstrap: bootstrapB, lastState: bootstrapB.state, updatedAtMs: Date.now() },
        { key: 'last_server_state', lastState: staleStateOfA, updatedAtMs: Date.now() - 1_000 },
      ]
    );

    // Open the app so Dexie runs the upgrade, with the API cut so nothing
    // can quietly repair the snapshot from the server.
    await page.route('**/api/v1/**', (route) => route.abort('failed'));
    await page.goto('/counter');
    await page.waitForTimeout(3_000);

    const record = await readEventStateRecord(page);
    expect(record).not.toBeNull();
    expect(record?.eventId).toBe(eventB.eventId);
    // The migration must fall back to the state it can prove belongs to B,
    // not adopt A's higher version.
    expect((record?.state as { version: number }).version).toBe(1);
    expect((record?.state as { eventOccupancy: number }).eventOccupancy).toBe(0);

    // And nothing of A's is on screen.
    await expect(page.locator('span.text-5xl.font-black')).toHaveText('0', { timeout: 15_000 });

    await page.unroute('**/api/v1/**');
    // The real pairing still works afterwards.
    await page.goto(`/pair#${tokenB}`);
    await page.waitForURL('**/counter');
    await expect(page.locator('span.text-5xl.font-black')).toHaveText('0');
  });

  test('le shell est réellement servi hors ligne par le service worker enregistré', async ({ page }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round2 Service Worker',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');

    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    await expect
      .poll(async () => spaceOccupancy(session, topo.eventId, topo.siteSpaceId), { timeout: 30_000 })
      .toBe(1);
    await waitForOutbox(page, (rows) => rows.length === 0);

    // `vite-plugin-pwa` injects its registration script into the built
    // index.html, which is what the E2E server serves — so this is the
    // production registration path, not one added for the test. With the
    // project's `registerType: 'prompt'` (and therefore no `clientsClaim`),
    // the worker installs on the first visit but only takes control of a
    // page from the *next* navigation onwards. So the first session of a
    // freshly-installed device is not offline-capable; every one after it
    // is. That is a real property of this configuration, worth stating
    // rather than papering over.
    await page.reload();
    const controlled = await waitForServiceWorkerControl(page);
    expect(controlled).toBe(true);

    await page.context().setOffline(true);
    await page.reload();

    // The shell boots from the precache and the counter restarts from its
    // local snapshot.
    await expect(page.locator('span.text-5xl.font-black')).toHaveText('1', { timeout: 20_000 });
  });
});
