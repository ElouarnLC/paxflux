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

  // Today this list is unconditionally empty: both
  // GET /events/:id/devices and the devices join in GET /events/:id/state
  // filter with `eq(deviceSessions.revokedAtMs, null)`. Drizzle compiles
  // that to a literal `revoked_at_ms = NULL`, which is never true in SQL
  // (NULL comparisons are UNKNOWN, not TRUE) — the correct predicate is
  // `isNull(deviceSessions.revokedAtMs)`. As a result no paired device
  // ever appears on the admin dashboard, and syncQuality always reports
  // "reliable" since offlineCount/totalPending never see any device.
  expect(devices).toHaveLength(1);

  // Once the query above is fixed, the remaining question this test is
  // for: the web client never calls POST /api/v1/device/heartbeat, so
  // lastSeenAtMs is only ever refreshed by bootstrap/batch calls — an idle
  // device would still silently flip to "Hors ligne" after 45s.
  expect(devices[0].isOnline).toBe(true);
});
