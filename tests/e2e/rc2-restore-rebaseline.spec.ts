import { test, expect } from '@playwright/test';
import {
  completeDevicePairing,
  createDeviceInviteToken,
  createDraftEventWithMainCheckpoint,
  getAdminSession,
  getEventDevices,
  getEventState,
  startEvent,
} from './helpers.js';
import { readEventStateRecord, readOutbox, seedAheadOfServerEventState } from './offline-helpers.js';

/**
 * RC2-A — a device paired again after a server restore must adopt the
 * restored state, in a real browser.
 *
 * The field report: a manual backup was restored, the dashboard correctly
 * went back to 10, every session was invalidated, and the same Chrome
 * browser was paired again with a fresh QR code — after which the counter
 * kept displaying 14. Closing and reopening the browser did not fix it,
 * because the stale value was the one being read back out of IndexedDB.
 *
 * A restore rolls the *server* back; it does not roll the browser back. This
 * spec stages that asymmetry directly — the web server cannot be stopped
 * mid-run to restore a database under it — and then performs a real pairing
 * against a real server. Everything after the seed is the product's own path:
 * `/pair#<token>`, `/device/pair`, `/device/bootstrap`, and whatever
 * CounterView reads back.
 */
test('un appareil ré-appairé après restauration adopte l’état restauré, pas son cache d’avant', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);

  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'RC2-A Restore Rebaseline',
    capacity: 500,
  });
  await startEvent(session, topo.eventId);

  // --- The device counts normally under its first pairing (S1). ---
  const firstToken = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
  await completeDevicePairing(page, firstToken);
  await expect(page.getByTestId('count-a-to-b')).toBeVisible();

  await page.getByTestId('count-a-to-b').click();
  await page.getByTestId('count-a-to-b').click();
  await expect.poll(async () => (await getEventState(session, topo.eventId)).occupancy.global, {
    timeout: 30_000,
  }).toBe(2);
  await expect(page.getByTestId('global-occupancy')).toHaveText('2', { timeout: 15_000 });

  const serverState = await getEventState(session, topo.eventId);
  expect(serverState.occupancy.global).toBe(2);

  // --- The server is restored to an earlier point; the browser is not. ---
  // Staged as the row a pre-restore device would still be holding: a version
  // far ahead of anything the restored server can report, and an occupancy
  // that never existed on it.
  const AHEAD_VERSION = 9_000;
  const STALE_OCCUPANCY = 14;
  await seedAheadOfServerEventState(page, {
    eventId: topo.eventId,
    version: AHEAD_VERSION,
    eventOccupancy: STALE_OCCUPANCY,
    serverTimeMs: Date.now() + 60 * 60 * 1000,
  });

  const seeded = await readEventStateRecord(page);
  expect(seeded, 'the pre-restore row must be in place before re-pairing').not.toBeNull();
  expect((seeded!.state as { eventOccupancy: number }).eventOccupancy).toBe(STALE_OCCUPANCY);

  // A restore invalidates every session, so the operator scans a fresh QR
  // code — in the same browser, which still holds the row above.
  const devicesBefore = await getEventDevices(session, topo.eventId);
  const secondToken = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
  await completeDevicePairing(page, secondToken);
  await expect(page.getByTestId('count-a-to-b')).toBeVisible();

  // --- The new pairing's bootstrap is the new baseline. ---
  await expect(
    page.getByTestId('global-occupancy'),
    'the counter must show what the restored server reports, not its pre-restore cache'
  ).toHaveText('2', { timeout: 30_000 });

  const stored = await readEventStateRecord(page);
  expect(stored, 'a baseline must be stored after the new pairing').not.toBeNull();
  const storedState = stored!.state as { version: number; eventOccupancy: number };
  expect(storedState.version, 'the stored baseline is the one the new bootstrap carried').toBeLessThan(
    AHEAD_VERSION
  );
  expect(storedState.eventOccupancy).toBe(2);

  // The pairing really did create a second device session: this is a new
  // identity, not a refresh of the old one.
  const devicesAfter = await getEventDevices(session, topo.eventId);
  expect(devicesAfter.length).toBe(devicesBefore.length + 1);

  // --- The event moves on from the restored point and is accepted. ---
  await page.getByTestId('count-a-to-b').click();
  await expect.poll(async () => (await getEventState(session, topo.eventId)).occupancy.global, {
    timeout: 30_000,
  }).toBe(3);
  await expect(page.getByTestId('global-occupancy')).toHaveText('3', { timeout: 15_000 });

  // --- And it survives a reload, with no site data cleared. ---
  await page.reload();
  await expect(page.getByTestId('count-a-to-b')).toBeVisible();
  await expect(
    page.getByTestId('global-occupancy'),
    'the pre-restore value must not reappear after a reload'
  ).toHaveText('3', { timeout: 30_000 });

  // Nothing was thrown away to get there: no wholesale IndexedDB clear.
  const outbox = await readOutbox(page);
  expect(Array.isArray(outbox)).toBe(true);

  await context.close();
});
