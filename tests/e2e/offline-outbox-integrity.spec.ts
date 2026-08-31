import { test, expect, Page } from '@playwright/test';
import {
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  addInternalTransferCheckpoint,
  startEvent,
  beginClosingEvent,
  forceCloseEvent,
  createDeviceInviteToken,
  adjustSpaceOccupancy,
  getEventState,
  AdminSession,
} from './helpers.js';
import {
  readOutbox,
  seedOutboxRows,
  seedLegacyV1Database,
  displayedOccupancy,
  uuid,
  StoredOutboxRow,
} from './offline-helpers.js';

const BATCH_URL = '**/api/v1/device/actions/batch';

async function spaceOccupancy(session: AdminSession, eventId: string, spaceId: string): Promise<number> {
  // `/events/:id/state` returns raw space rows under `spaces` and their
  // occupancies separately, keyed by space id, under `occupancy.spaces`.
  const state = await getEventState(session, eventId);
  const occupancies: Record<string, number> = state.occupancy.spaces;
  return occupancies[spaceId] ?? 0;
}

/** Waits until the outbox settles on a predicate, so specs never race the flush loop. */
async function waitForOutbox(
  page: Page,
  predicate: (rows: StoredOutboxRow[]) => boolean,
  timeoutMs = 15_000
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

test.describe('Phase 6 — intégrité de l’outbox hors ligne', () => {
  test('au redémarrage, le compteur repart du dernier état autoritatif, pas du bootstrap initial', async ({
    page,
  }) => {
    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Repro Snapshot Divergent',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');

    // The device bootstraps at occupancy 0 and caches that snapshot.
    await expect(page.getByTestId('global-occupancy')).toHaveText('0');

    // The authoritative state then moves to 5 through a supervisor
    // adjustment, which reaches this device over SSE only.
    await adjustSpaceOccupancy(session, topo.eventId, topo.siteSpaceId, 5);
    await expect(page.getByTestId('global-occupancy')).toHaveText('5', { timeout: 10_000 });

    // Restart with the API unreachable. Cutting the API rather than the
    // whole network keeps this test on its subject — which local snapshot
    // does the counter restart from — instead of also exercising the
    // service worker's precache, which `offline-round2.spec.ts` covers
    // separately against a genuinely offline reload.
    await page.route('**/api/v1/**', (route) => route.abort('failed'));
    await page.reload();

    // Today the counter reads `device_cache['bootstrap_config'].lastState`,
    // which was written once at bootstrap time and never refreshed: SSE
    // persists its state under a *different* key (`last_server_state`).
    // So the screen restarts from the stale 0 instead of the latest 5.
    await expect(page.getByTestId('global-occupancy')).toHaveText('5', { timeout: 10_000 });
  });

  test('une action rejetée n’est pas renvoyée en boucle au serveur', async ({ page }) => {
    test.setTimeout(120_000);

    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Repro Rejected Loop',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');

    // A genuine refusal, produced by the server rather than injected into
    // the response: the tap is made offline while the event is live, and
    // the event is closed for good before the device reconnects. Rewriting
    // the acknowledgment instead would have applied the movement first and
    // then lied about it.
    await page.context().setOffline(true);
    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    await waitForOutbox(page, (rows) => rows.length === 1);

    await beginClosingEvent(session, topo.eventId);
    await forceCloseEvent(session, topo.eventId, 'Appareil hors ligne au moment de la fermeture');

    let batchRequests = 0;
    await page.route(BATCH_URL, async (route) => {
      batchRequests += 1;
      await route.continue();
    });
    await page.context().setOffline(false);

    await expect
      .poll(async () => (await readOutbox(page))[0]?.sendState, { timeout: 30_000 })
      .toBe('rejected');

    // Before Phase 6 the flush deleted only applied/duplicate acks, saw a
    // non-empty outbox and immediately re-armed `setTimeout(triggerFlush,
    // 100)` — a 100 ms hot loop against a refusal that will never change on
    // its own. Measured at 73 requests in 5 seconds.
    const afterRefusal = batchRequests;
    await page.waitForTimeout(8_000);
    expect(batchRequests - afterRefusal).toBe(0);

    // And the action is still there, carrying the server's own code: a
    // refusal is never silent data loss.
    const rows = await readOutbox(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].sendState).toBe('rejected');
    expect(rows[0].lastErrorCode).toBe('EVENT_NOT_LIVE');
    expect(await spaceOccupancy(session, topo.eventId, topo.siteSpaceId)).toBe(0);
  });

  test('une outbox d’une session précédente n’est jamais rejouée sous un nouvel appairage', async ({
    page,
  }) => {
    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Repro Outbox Ownership',
      capacity: 200,
    });
    const { zoneSpaceId, internalCheckpointId } = await addInternalTransferCheckpoint(session, topo, {
      zoneName: 'VIP',
      capacity: 50,
    });
    await startEvent(session, topo.eventId);

    const tokenA = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
    const tokenB = await createDeviceInviteToken(session, topo.eventId, internalCheckpointId);

    // Device A: paired on the external boundary (Extérieur ⇄ Site).
    await page.goto(`/pair#${tokenA}`);
    await page.waitForURL('**/counter');

    // Cut the batch endpoint so A's tap stays queued locally.
    const blockBatch = (route: import('@playwright/test').Route) => route.abort('failed');
    await page.route(BATCH_URL, blockBatch);

    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    const queued = await waitForOutbox(page, (rows) => rows.length === 1);
    expect(queued).toHaveLength(1);
    const orphanActionId = queued[0].clientActionId;

    // The same browser is re-paired as device B, on a *different* checkpoint
    // (Site ⇄ VIP). A's queued tap is still sitting in the local outbox.
    await page.goto(`/pair#${tokenB}`);
    await page.waitForURL('**/counter');

    await page.unroute(BATCH_URL, blockBatch);
    await page.waitForTimeout(8_000);

    // Today the outbox row carries no identity at all and the batch endpoint
    // infers event/checkpoint/session from the *current* cookie, so A's tap
    // is applied as a Site → VIP transfer made by B.
    expect(await spaceOccupancy(session, topo.eventId, zoneSpaceId)).toBe(0);
    expect(await spaceOccupancy(session, topo.eventId, topo.siteSpaceId)).toBe(0);

    // It must not be deleted either: an unreconciled count is not garbage.
    const rows = await readOutbox(page);
    const orphan = rows.find((r) => r.clientActionId === orphanActionId);
    expect(orphan).toBeDefined();
    expect(orphan?.sendState).toBe('quarantined');
  });

  test('une outbox héritée sans identité est mise en quarantaine, jamais attribuée', async ({ page }) => {
    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Repro Legacy Outbox',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    // Land on the origin *without* loading the SPA: `/health/live` is served
    // by the API on the same origin, so IndexedDB is reachable while
    // main.tsx — which opens Dexie at the current version on import — never
    // runs. The legacy database must exist before the app first sees it.
    await page.goto('/health/live');
    const legacyActionId = uuid();
    await seedLegacyV1Database(page, [
      {
        clientActionId: legacyActionId,
        sequence: 1,
        type: 'count',
        direction: 'a_to_b',
        clientCreatedAtMs: Date.now() - 60_000,
        attempts: 0,
        sendState: 'pending',
        createdAtMs: Date.now() - 60_000,
      },
    ]);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');
    await page.waitForTimeout(8_000);

    // The migration must never guess that this row belongs to the device
    // that happens to be pairing now.
    expect(await spaceOccupancy(session, topo.eventId, topo.siteSpaceId)).toBe(0);

    const rows = await readOutbox(page);
    const legacy = rows.find((r) => r.clientActionId === legacyActionId);
    expect(legacy).toBeDefined();
    expect(legacy?.sendState).toBe('quarantined');
    expect(legacy?.owner).toBeUndefined();
  });

  test('une action laissée en `sending` par un crash est reprise et appliquée au plus une fois', async ({
    page,
  }) => {
    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Repro Sending Recovery',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');
    await expect(page.getByTestId('global-occupancy')).toHaveText('0');

    const owner = await page.evaluate(async () => {
      const res = await fetch('/api/v1/device/bootstrap', { credentials: 'include' });
      const bootstrap = await res.json();
      return {
        deviceSessionId: bootstrap.deviceSession.id,
        eventId: bootstrap.event.id,
        checkpointId: bootstrap.checkpoint.id,
      };
    });

    // A tap that was in flight when the app was killed: persisted as
    // `sending`, with no acknowledgment ever received.
    const strandedId = uuid();
    await seedOutboxRows(page, [
      {
        clientActionId: strandedId,
        sequence: 900,
        type: 'count',
        direction: 'a_to_b',
        clientCreatedAtMs: Date.now(),
        attempts: 1,
        sendState: 'sending',
        createdAtMs: Date.now(),
        owner,
      },
    ]);

    await page.reload();
    await page.waitForTimeout(8_000);

    // Uncertain ACK: `clientActionId` idempotence means a re-send is either
    // the first application or a duplicate — never a second count.
    expect(await spaceOccupancy(session, topo.eventId, topo.siteSpaceId)).toBe(1);
    const rows = await readOutbox(page);
    expect(rows.find((r) => r.clientActionId === strandedId)).toBeUndefined();
    expect(await displayedOccupancy(page)).toBe(1);
  });

  test('un undo dont l’ACK original est incertain n’applique le comptage qu’une fois', async ({ page }) => {
    const session = await getAdminSession();
    const topo = await createDraftEventWithMainCheckpoint(session, {
      name: 'Repro Uncertain Reversal',
      capacity: 200,
    });
    await startEvent(session, topo.eventId);
    const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

    await page.goto(`/pair#${token}`);
    await page.waitForURL('**/counter');

    const owner = await page.evaluate(async () => {
      const res = await fetch('/api/v1/device/bootstrap', { credentials: 'include' });
      const bootstrap = await res.json();
      return {
        deviceSessionId: bootstrap.deviceSession.id,
        eventId: bootstrap.event.id,
        checkpointId: bootstrap.checkpoint.id,
      };
    });

    // Step 1: a real tap reaches the server and is applied. The batch
    // endpoint is briefly cut so the action's id can be read out of the
    // outbox before it drains.
    const blockBatch = (route: import('@playwright/test').Route) => route.abort('failed');
    await page.route(BATCH_URL, blockBatch);
    await page.getByRole('button', { name: /ENTRÉE/ }).click();
    const queued = await waitForOutbox(page, (rows) => rows.length === 1);
    const countId = queued[0].clientActionId;

    await page.unroute(BATCH_URL, blockBatch);
    const drainedFirst = await waitForOutbox(page, (rows) => rows.length === 0);
    expect(drainedFirst).toHaveLength(0);
    expect(await spaceOccupancy(session, topo.eventId, topo.siteSpaceId)).toBe(1);

    // Step 2: the acknowledgment was lost on the way back, so the device
    // still holds the count as `sending` — and the operator then undoes it.
    const reversalId = uuid();
    await seedOutboxRows(page, [
      {
        clientActionId: countId,
        sequence: 800,
        type: 'count',
        direction: 'a_to_b',
        clientCreatedAtMs: Date.now(),
        attempts: 1,
        sendState: 'sending',
        createdAtMs: Date.now(),
        owner,
      },
      {
        clientActionId: reversalId,
        sequence: 801,
        type: 'reversal',
        targetClientActionId: countId,
        clientCreatedAtMs: Date.now(),
        attempts: 0,
        sendState: 'pending',
        createdAtMs: Date.now() + 1,
        owner,
      },
    ]);

    await page.reload();
    const drained = await waitForOutbox(page, (rows) => rows.length === 0);
    expect(drained).toHaveLength(0);

    // The replayed count must be an idempotent no-op, so the reversal
    // cancels exactly one application — never leaving a phantom +1.
    expect(await spaceOccupancy(session, topo.eventId, topo.siteSpaceId)).toBe(0);
  });
});
