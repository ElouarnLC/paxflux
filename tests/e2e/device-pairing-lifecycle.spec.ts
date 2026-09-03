import { test, expect, Page } from '@playwright/test';
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  completeDevicePairing,
  createDeviceInvite,
  createDeviceInviteToken,
  createDraftEventWithMainCheckpoint,
  getAdminSession,
  getEventDevices,
  revokeDeviceSession,
  startEvent,
} from './helpers.js';

async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

// Phase 5 acceptance: the whole device cycle, from the QR an admin hands
// out to a counter that stays visible while idle and locks itself the
// moment its session is pulled.
test('cycle appareil complet : appairage sur un second appareil, heartbeat, supervision, puis révocation', async ({
  browser,
}) => {
  test.setTimeout(150_000);

  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'Repro Cycle Appareil',
    capacity: 50,
  });
  await startEvent(session, topo.eventId);

  const invite = await createDeviceInvite(session, topo.eventId, topo.mainCheckpointId);
  // The server owns this URL: it must be absolute and carry the secret in
  // the fragment, never in the path or query.
  expect(invite.pairUrl).toMatch(/^https?:\/\/[^/]+\/pair#/);
  expect(invite.pairUrl.endsWith(`#${invite.token}`)).toBe(true);

  // A distinct browser context stands in for the phone: its own cookie jar,
  // so the device session is genuinely separate from the admin's.
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();

  const pairPath = new URL(invite.pairUrl).pathname + new URL(invite.pairUrl).hash;
  await phone.goto(pairPath);
  await phone.waitForURL('**/counter');

  // The secret must not be left sitting in the address bar after use.
  expect(phone.url()).not.toContain(invite.token);

  const devicesAfterPairing = await getEventDevices(session, topo.eventId);
  expect(devicesAfterPairing).toHaveLength(1);
  const deviceId = devicesAfterPairing[0].id;

  // Idle far beyond the 45s offline threshold, with no tap at all: only the
  // periodic heartbeat can keep this device visible as online.
  await phone.waitForTimeout(50_000);

  const devicesWhileIdle = await getEventDevices(session, topo.eventId);
  expect(devicesWhileIdle[0].isOnline).toBe(true);
  expect(devicesWhileIdle[0].lastPendingCount).toBe(0);

  // The supervisor's own screen shows the same verdict.
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginAsAdmin(adminPage);
  await adminPage.goto(`/admin/events/${topo.eventId}/devices`);
  // The written status, not the bullet that used to precede it: the status
  // is now rendered by the shared StatusText component, which pairs the
  // word with an icon instead of a decorative character. Same assertion.
  await expect(adminPage.getByText('En ligne')).toBeVisible({ timeout: 10_000 });

  // The supervisor pulls the device.
  await revokeDeviceSession(session, deviceId);

  // The counter finds out on its next heartbeat and locks itself, without
  // the operator having to reload anything.
  await expect(phone.getByText(/Appareil révoqué/i)).toBeVisible({ timeout: 30_000 });
  await expect(phone.getByRole('button', { name: /ENTRÉE/i })).toBeDisabled();

  await phoneContext.close();
  await adminContext.close();
});

test("l'admin affiche l'URL d'appairage fournie par le serveur, sans la reconstruire depuis le navigateur", async ({
  page,
}) => {
  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'Repro URL Canonique UI',
    capacity: 20,
  });

  await loginAsAdmin(page);

  // Rewrite the server's answer to a canonical URL that is deliberately
  // *not* this browser's origin. An admin UI that rebuilds the pairing URL
  // from window.location would display 127.0.0.1 here and fail; one that
  // uses the server's value shows it verbatim.
  const canonicalOrigin = 'https://paxflux.example.test';
  await page.route('**/api/v1/events/*/device-invites', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, pairUrl: `${canonicalOrigin}/pair#${body.token}` },
    });
  });

  await page.goto(`/admin/events/${topo.eventId}/devices`);
  await page.getByRole('button', { name: /Générer le QR Code/i }).click();

  await expect(page.getByText(new RegExp(`${canonicalOrigin}/pair#`))).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/127\.0\.0\.1.*?\/pair#/)).not.toBeVisible();
});

test('un QR déjà utilisé ne peut pas appairer un second appareil', async ({ browser }) => {
  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'Repro QR Usage Unique',
    capacity: 20,
  });
  await startEvent(session, topo.eventId);
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  const firstContext = await browser.newContext();
  const firstPhone = await firstContext.newPage();
  await completeDevicePairing(firstPhone, token);

  // A second handset scanning the same (photographed) QR must be refused —
  // SPEC §9.1: single use is what limits the damage of a leaked code.
  const secondContext = await browser.newContext();
  const secondPhone = await secondContext.newPage();
  await secondPhone.goto(`/pair#${token}`);

  await expect(secondPhone.getByText(/Erreur d’appairage/i)).toBeVisible({ timeout: 10_000 });
  expect(secondPhone.url()).not.toContain('/counter');

  const devices = await getEventDevices(session, topo.eventId);
  expect(devices).toHaveLength(1);

  await firstContext.close();
  await secondContext.close();
});
