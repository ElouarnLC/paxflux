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

  // The device-visibility bug that once made this list unconditionally
  // empty was fixed in Phase 3, so an empty list here is now a genuine
  // failure rather than an unrelated blocker.
  expect(devices).toHaveLength(1);

  // Only the periodic heartbeat can keep this true: nothing else refreshes
  // lastSeenAtMs for a counter that is open but idle.
  expect(devices[0].isOnline).toBe(true);
});
