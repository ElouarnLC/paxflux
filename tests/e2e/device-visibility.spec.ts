import { test, expect } from '@playwright/test';
import {
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  startEvent,
  createDeviceInviteToken,
  getEventDevices,
} from './helpers.js';

test('un appareil appairé apparaît immédiatement dans la liste des appareils de l\'événement', async ({ page }) => {
  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'Repro Device Visibility',
    capacity: 30,
  });
  await startEvent(session, topo.eventId);
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  await page.goto(`/pair#${token}`);
  await page.waitForURL('**/counter');

  // No wait needed: a freshly paired, non-revoked device must show up
  // right away. Today GET /events/:id/devices (and the devices join in
  // GET /events/:id/state) filter with
  // eq(deviceSessions.revokedAtMs, null), which Drizzle compiles to a
  // literal `revoked_at_ms = NULL` — always false in SQL, since NULL
  // comparisons are UNKNOWN, never TRUE. The correct predicate is
  // isNull(deviceSessions.revokedAtMs). As a result this list is
  // unconditionally empty and no paired device ever appears on the admin
  // dashboard.
  const devices = await getEventDevices(session, topo.eventId);
  expect(devices).toHaveLength(1);
});
