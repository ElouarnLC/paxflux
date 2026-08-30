import { test, expect } from '@playwright/test';
import {
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  startEvent,
  beginClosingEvent,
  createDeviceInviteToken,
  getEventState,
} from './helpers.js';

test('le compteur indique clairement qu\'un événement en brouillon n\'est pas encore démarré', async ({ page }) => {
  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'Repro Draft Counter',
    capacity: 30,
  });
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  await page.goto(`/pair#${token}`);
  await page.waitForURL('**/counter');

  // The buttons are correctly disabled while the event is `draft`, but
  // nothing on screen explains why to the person holding the device —
  // unlike the explicit banner shown during `closing`.
  await expect(
    page.getByText(/événement n'a pas encore démarré|pas encore commencé|en préparation/i)
  ).toBeVisible();
});

test('un événement en `closing` désactive réellement les boutons de comptage', async ({ page }) => {
  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'Repro Closing Gate',
    capacity: 30,
  });
  await startEvent(session, topo.eventId);
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  await page.goto(`/pair#${token}`);
  await page.waitForURL('**/counter');

  await beginClosingEvent(session, topo.eventId);
  // Force a fresh bootstrap fetch to pick up the new `closing` status
  // (the counter does not react live to the event-status SSE message).
  await page.reload();

  await expect(page.getByText(/nouveaux comptages désactivés/i)).toBeVisible();

  // Assert the disabled state directly rather than clicking and checking
  // occupancy: once this is fixed, .click() on a genuinely disabled button
  // would just hang until Playwright's actionability timeout instead of
  // failing meaningfully.
  const entryButton = page.getByRole('button', { name: /ENTRÉE/i });
  await expect(entryButton).toBeDisabled();
});

test('les actions déjà en attente avant `closing` continuent d\'être drainées une fois le compteur reconnecté', async ({ page, context }) => {
  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'Repro Closing Drain',
    capacity: 30,
  });
  await startEvent(session, topo.eventId);
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  await page.goto(`/pair#${token}`);
  await page.waitForURL('**/counter');

  const stateBaseline = await getEventState(session, topo.eventId);

  // The device goes offline and queues a tap while the event is still live.
  await context.setOffline(true);
  await page.getByRole('button', { name: /ENTRÉE/i }).click();

  // The event moves to `closing` while that action is still sitting
  // unsent in the device's outbox — the admin's decision to start closing
  // has nothing to do with this device's connectivity.
  await beginClosingEvent(session, topo.eventId);

  // The device reconnects: this action was created while the event was
  // still `live`, so it must still be drained and applied even though the
  // event is now `closing` — closing must only refuse *new* taps, not ones
  // already queued beforehand. This is currently true (today's server does
  // not yet distinguish new vs. queued closing-time taps at all — see the
  // "désactive réellement les boutons" test above), and must remain true
  // once that distinction is added.
  await context.setOffline(false);
  await expect(page.getByText(/EN LIGNE/)).toBeVisible({ timeout: 10_000 });

  // The "EN LIGNE" badge flipping is a reasonable signal, but the batch
  // flush it reflects (pendingCount reaching 0 client-side) and the
  // server having actually applied and persisted the movement are two
  // different moments. Poll instead of reading once, to avoid a race with
  // that async flush.
  await expect
    .poll(async () => (await getEventState(session, topo.eventId)).occupancy.global, { timeout: 10_000 })
    .toBe(stateBaseline.occupancy.global + 1);
});
