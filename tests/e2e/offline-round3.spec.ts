import { test, expect, Page, Route } from '@playwright/test';
import {
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  addInternalTransferCheckpoint,
  startEvent,
  createDeviceInviteToken,
  getEventState,
  getEventDevices,
  AdminSession,
} from './helpers.js';
import { readOutbox, readDeviceConfigRecord, StoredOutboxRow } from './offline-helpers.js';

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

test.describe('Phase 6 round 3 — identité de l’appairage et taxonomie des réponses', () => {
  test('un bootstrap défaillant après appairage ne laisse jamais l’ancienne identité opérer', async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round3 Stale Pairing Identity',
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

    // A has a real local pending count that cannot leave.
    const blockBatch = (route: Route) => route.abort('failed');
    await page.route(BATCH_URL, blockBatch);
    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    const queued = await waitForOutbox(page, (rows) => rows.length === 1);
    const orphanId = queued[0].clientActionId;

    // A second tab left open on the counter, still showing device A. Its
    // batch endpoint is cut too: otherwise it would legitimately drain A's
    // queue *as A* — correct behaviour, but it would make the scenario
    // below non-deterministic.
    const secondTab = await context.newPage();
    await secondTab.route(BATCH_URL, blockBatch);
    await secondTab.goto('/counter');
    await expect(secondTab.getByRole('button', { name: /ENTRÉE/ })).toBeVisible({ timeout: 15_000 });

    // From here on, every bootstrap fails — B pairs but is never configured.
    const failBootstrap = (route: Route) => route.abort('failed');
    await page.route(BOOTSTRAP_URL, failBootstrap);
    await secondTab.route(BOOTSTRAP_URL, failBootstrap);

    const pairResponse = page.waitForResponse(
      (response) => response.url().includes('/api/v1/device/pair') && response.status() === 200,
      { timeout: 30_000 }
    );
    await page.goto(`/pair#${tokenB}`);
    const sessionBId = (await (await pairResponse).json()).deviceSession.id as string;

    await page.waitForURL('**/counter', { timeout: 30_000 });

    // The counter is explicitly non-operational rather than falling back to
    // A: no tap can be created at all.
    await expect(page.getByText(/Appairage en cours — configuration en attente/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: /ENTRÉE/ })).toHaveCount(0);

    // The tab that was already open stops acting as A too: the pairing it
    // was showing no longer matches the cookie this browser holds.
    await expect(secondTab.getByRole('button', { name: /ENTRÉE/ })).toHaveCount(0, { timeout: 25_000 });

    // The stored configuration records the handoff and holds no bootstrap.
    const config = await readDeviceConfigRecord(page);
    expect(config?.bootstrap).toBeUndefined();
    expect(config?.pendingSessionId).toBe(sessionBId);

    // Nothing of A's was applied under B — B counts at the VIP door, so a
    // leak would show there — and nothing was applied at all, since no
    // batch can leave either tab.
    await page.waitForTimeout(20_000);
    expect(await spaceOccupancy(session, topo.eventId, zoneSpaceId)).toBe(0);
    expect(await spaceOccupancy(session, topo.eventId, topo.siteSpaceId)).toBe(0);

    const devices = await getEventDevices(session, topo.eventId);
    const deviceB = devices.find((d) => d.id === sessionBId);
    expect(deviceB).toBeDefined();
    expect(deviceB?.lastPendingCount).toBe(0);

    // And A's count is still there, never deleted.
    const rows = await readOutbox(page);
    expect(rows.find((r) => r.clientActionId === orphanId)).toBeDefined();

    await secondTab.close();
  });

  test('un 200 syntaxiquement valide mais structurellement faux est un ACK incertain, en bloc', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round3 Structurally Invalid 200',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');

    // Every bad response below is synthesised, never forwarded to the
    // server: the point is what the *client* does with an untrustworthy
    // 200, and letting the real request through would apply the movement
    // and muddy the reading.
    const wellFormedState = () => ({
      version: 7,
      eventStatus: 'live',
      eventOccupancy: 0,
      eventCapacity: 200,
      spaces: [
        { id: topo.externalSpaceId, name: 'Extérieur', kind: 'external', occupancy: 0, capacity: null },
        { id: topo.siteSpaceId, name: 'Site', kind: 'leaf', occupancy: 0, capacity: 200 },
      ],
      serverTimeMs: Date.now(),
    });

    const respondWith = (build: (sentActionIds: string[]) => unknown) => async (route: Route) => {
      const sent = JSON.parse(route.request().postData() ?? '{}') as {
        actions?: Array<{ clientActionId: string }>;
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(build((sent.actions ?? []).map((a) => a.clientActionId))),
      });
    };

    async function expectUncertain(label: string) {
      await page.waitForTimeout(4_000);
      const rows = await readOutbox(page);
      expect(rows, label).toHaveLength(1);
      expect(rows[0].sendState, label).toBe('pending');
      expect(rows[0].lastErrorCode, label).toBe('INVALID_BATCH_RESPONSE');
      // No invalid snapshot was persisted either: the projection still
      // stands on the last authoritative state the device can trust.
      await expect(page.getByTestId('global-occupancy')).toHaveText('1');
    }

    // 1. The empty shell a truncated body produces. Parses as JSON, says
    //    nothing, and passes an `Array.isArray`/`typeof` check.
    const emptyShell = respondWith(() => ({ acknowledged: [{}], state: {} }));
    await page.route(BATCH_URL, emptyShell);
    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    await expectUncertain('empty shell');
    await page.unroute(BATCH_URL, emptyShell);

    // 2. A perfectly well-formed acknowledgment — for an action this device
    //    never sent. That is not an answer to this request.
    const strayAck = respondWith(() => ({
      acknowledged: [
        { clientActionId: '00000000-0000-4000-8000-0000000000ff', status: 'applied', movementId: 1 },
      ],
      state: wellFormedState(),
    }));
    await page.route(BATCH_URL, strayAck);
    await expectUncertain('acknowledgment outside the batch');
    await page.unroute(BATCH_URL, strayAck);

    // 3. The case only a full schema catches: addressed to the right
    //    action, right shape, but a status the client has no rule for — and
    //    a state missing its timestamp, which the freshness comparison
    //    would then read as older than everything.
    const wellAddressedNonsense = respondWith((ids) => {
      const state: Record<string, unknown> = wellFormedState();
      delete state.serverTimeMs;
      return {
        acknowledged: ids.map((clientActionId) => ({ clientActionId, status: 'definitely-applied' })),
        state,
      };
    });
    await page.route(BATCH_URL, wellAddressedNonsense);
    await expectUncertain('valid JSON, invalid contract');
    await page.unroute(BATCH_URL, wellAddressedNonsense);

    // With a trustworthy response, the retry resolves it exactly once.
    await waitForOutbox(page, (rows) => rows.length === 0);
    await expect
      .poll(async () => spaceOccupancy(session, topo.eventId, topo.siteSpaceId), { timeout: 30_000 })
      .toBe(1);
  });

  test('un 400 est déterministe : aucun renvoi automatique', async ({ page }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Round3 HTTP 400',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');

    let requests = 0;
    await page.route(BATCH_URL, async (route) => {
      requests += 1;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'VALIDATION_ERROR', title: 'Payload invalide', status: 400 }),
      });
    });

    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    await expect.poll(async () => (await readOutbox(page))[0]?.sendState, { timeout: 20_000 }).toBe('rejected');

    const rows = await readOutbox(page);
    expect(rows[0].lastErrorCode).toBe('HTTP_400');

    // The server understood the request and refused it. Re-sending the same
    // bytes produces the same answer, so it waits for a human.
    const afterRefusal = requests;
    await page.waitForTimeout(10_000);
    expect(requests - afterRefusal).toBe(0);

    // Kept and surfaced, never dropped.
    expect(await readOutbox(page)).toHaveLength(1);
    await expect(page.getByText(/À RÉGULARISER/)).toBeVisible({ timeout: 10_000 });
  });

  for (const { status, label } of [
    { status: 429, label: 'une limite de débit' },
    { status: 503, label: 'une indisponibilité serveur' },
  ]) {
    test(`${label} (${status}) reste retryable`, async ({ page }) => {
      test.setTimeout(120_000);

      const session = await getAdminSession();
      const topo = await createDraftEventWithMainCheckpoint(session, {
        name: `Round3 HTTP ${status}`,
        capacity: 200,
      });
      await startEvent(session, topo.eventId);
      const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

      await page.goto(`/pair#${token}`);
      await page.waitForURL('**/counter');

      let requests = 0;
      const failWithStatus = async (route: Route) => {
        requests += 1;
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'INTERNAL_ERROR', status }),
        });
      };
      await page.route(BATCH_URL, failWithStatus);

      await page.getByRole('button', { name: /ENTRÉE/ }).click();
      await page.waitForTimeout(12_000);

      // No verdict was expressed about the action, so it stays retryable and
      // the engine keeps trying — with backoff, not in a hot loop.
      expect(requests).toBeGreaterThan(1);
      expect(requests).toBeLessThan(25);

      const rows = await readOutbox(page);
      expect(rows).toHaveLength(1);
      expect(rows[0].sendState).toBe('pending');
      expect(rows[0].lastErrorCode).toBe(`HTTP_${status}`);

      // And it resolves as soon as the server is well again.
      await page.unroute(BATCH_URL, failWithStatus);
      await waitForOutbox(page, (rows) => rows.length === 0);
      await expect
        .poll(async () => spaceOccupancy(session, topo.eventId, topo.siteSpaceId), { timeout: 30_000 })
        .toBe(1);
    });
  }
});
