import { test, expect } from '@playwright/test';
import {
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  startEvent,
  createDeviceInviteToken,
  getEventDevices,
} from './helpers.js';

test('un compteur ouvert mais inactif reste signalé en ligne (heartbeat périodique)', async ({ page }) => {
  test.setTimeout(70_000);

  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'Repro Heartbeat',
    capacity: 30,
  });
  await startEvent(session, topo.eventId);
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  await page.goto(`/pair#${token}`);
  await page.waitForURL('**/counter');

  // No taps performed: an idle field device sitting open on the counter
  // screen. The admin dashboard considers a device offline after 45s of
  // silence (apps/server/src/routes/devices.ts). A periodic heartbeat is
  // the only thing that should keep it marked online while idle.
  await page.waitForTimeout(47_000);

  const devices = await getEventDevices(session, topo.eventId);

  // This test is about the heartbeat only. Whether a paired device shows
  // up in this list at all is a separate, already-covered concern (see
  // device-visibility.spec.ts — a Drizzle `eq(col, null)` bug that makes
  // this list unconditionally empty). Don't let that unrelated cause show
  // up as a failure here: skip instead, so a red run of this test always
  // means "heartbeat is missing", never "devices list is empty".
  test.skip(
    devices.length === 0,
    'Bloqué par le bug de visibilité (voir device-visibility.spec.ts) — impossible d\'isoler le heartbeat tant que la liste est vide.'
  );

  // Once the list itself is fixed: the web client never calls
  // POST /api/v1/device/heartbeat, so lastSeenAtMs is only ever refreshed
  // by bootstrap/batch calls — an idle device still flips to "Hors ligne"
  // after 45s.
  expect(devices[0].isOnline).toBe(true);
});
