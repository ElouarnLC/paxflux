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

test('un événement en `closing` bloque réellement les nouveaux comptages malgré le message affiché', async ({ page }) => {
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

  const stateBefore = await getEventState(session, topo.eventId);
  await page.getByRole('button', { name: /ENTRÉE/i }).click();
  await page.waitForTimeout(500); // let the outbox flush the tap

  const stateAfter = await getEventState(session, topo.eventId);

  // The banner claims new counts are disabled during closing. Today the
  // button stays enabled and the server (movements.ts) still accepts
  // counts for `closing` events, so the tap is applied anyway.
  expect(stateAfter.occupancy.global).toBe(stateBefore.occupancy.global);
});
