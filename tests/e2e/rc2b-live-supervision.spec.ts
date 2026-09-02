import { test, expect, Page } from '@playwright/test';
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  startEvent,
  createDeviceInviteToken,
  adjustSpaceOccupancy,
  DraftEventTopology,
  AdminSession,
} from './helpers.js';

/**
 * RC2-B — the dashboard and the analytics screen must stay current during a
 * live event, without the operator pressing F5.
 *
 * The field failure both of these reproduce: the dashboard loaded `/state`
 * once and thereafter only applied SSE state frames, which carry occupancy
 * and lifecycle but never devices or sync quality. A device goes offline
 * when its heartbeat *stops*, and silence emits no frame — so the sync card
 * could still read "Fiable / Tous les appareils sont connectés et à jour"
 * long after the device-management screen, reading the same server, had
 * moved the device to offline.
 */

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

async function liveEventWithCheckpoint(
  session: AdminSession,
  name: string
): Promise<DraftEventTopology> {
  const topo = await createDraftEventWithMainCheckpoint(session, { name, capacity: 200 });
  await startEvent(session, topo.eventId);
  return topo;
}

test('le tableau de bord converge vers l’état serveur d’un appareil, hors ligne puis reconnecté, sans reload', async ({
  browser,
}) => {
  // One scenario covers both directions: waiting out a real 45s heartbeat
  // expiry once is enough to prove the loop, and the reconnection is then
  // free.
  test.setTimeout(180_000);

  const session = await getAdminSession();
  const topo = await liveEventWithCheckpoint(session, 'RC2B Convergence Supervision');
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  const deviceContext = await browser.newContext();
  const devicePage = await deviceContext.newPage();
  await devicePage.goto(`/pair#${token}`);
  await devicePage.waitForURL('**/counter');

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginAsAdmin(adminPage);
  await adminPage.goto(`/admin?event=${topo.eventId}`);

  // The device has just paired, so the server sees it online and drained.
  await expect(adminPage.getByTestId('sync-presence')).toHaveText('1 appareil en ligne sur 1', {
    timeout: 20_000,
  });
  await expect(adminPage.getByTestId('sync-pending')).toHaveText('Aucune action en attente');

  // The phone loses connectivity. Nothing is pushed to the dashboard by
  // this: the device simply stops heartbeating, and after
  // DEVICE_OFFLINE_THRESHOLD_MS (45s) the server starts calling it offline.
  await deviceContext.setOffline(true);

  // No reload anywhere below this line. Only the dashboard's own supervision
  // refresh can move these figures.
  await expect(adminPage.getByTestId('sync-presence')).toHaveText('0 appareil en ligne sur 1', {
    timeout: 90_000,
  });
  await expect(adminPage.getByTestId('sync-detail')).toContainText(/aucun appareil ne répond/i);
  // The device table on the same screen must agree with the card.
  await expect(adminPage.getByRole('row').filter({ hasText: /Hors ligne/ })).toHaveCount(1);

  // The phone comes back. Its next heartbeat restores the server's verdict,
  // and the dashboard must recover on its own.
  await deviceContext.setOffline(false);

  await expect(adminPage.getByTestId('sync-presence')).toHaveText('1 appareil en ligne sur 1', {
    timeout: 60_000,
  });
  await expect(adminPage.getByTestId('sync-detail')).toContainText(/tous les appareils appairés répondent/i);

  await deviceContext.close();
  await adminContext.close();
});

test('un événement sans appareil ne prétend jamais que tous les appareils sont connectés', async ({
  page,
}) => {
  const session = await getAdminSession();
  const topo = await liveEventWithCheckpoint(session, 'RC2B Aucun Appareil');

  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);

  // The server returns `reliable` here — nothing is offline and nothing is
  // pending, because there is nothing at all. The verdict is not
  // reinterpreted; what is said about it must simply be true.
  await expect(page.getByTestId('sync-presence')).toHaveText('Aucun appareil appairé', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('sync-detail')).toContainText(/aucun appareil de comptage/i);
  await expect(page.getByText('Tous les appareils sont connectés et à jour.')).toHaveCount(0);
  await expect(page.getByTestId('sync-pending')).toHaveCount(0);
});

test('les statistiques se mettent à jour toutes seules pendant l’événement', async ({ page }) => {
  test.setTimeout(120_000);

  const session = await getAdminSession();
  const topo = await liveEventWithCheckpoint(session, 'RC2B Analytics Near Live');

  // Some history before the screen opens, so the initial render has known
  // non-zero values and a later change is unambiguous.
  await adjustSpaceOccupancy(session, topo.eventId, topo.siteSpaceId, 4, 'Recalage initial RC2B');

  await loginAsAdmin(page);
  await page.goto(`/admin/events/${topo.eventId}/analytics`);

  await expect(page.getByTestId('analytics-current-occupancy')).toHaveText('4', { timeout: 20_000 });
  await expect(page.getByTestId('analytics-total-entries')).toHaveText('+4');

  // Real movements happen while the page is already rendered. No reload
  // follows: only the screen's own refresh can bring these in.
  await adjustSpaceOccupancy(session, topo.eventId, topo.siteSpaceId, 9, 'Arrivées RC2B');

  await expect(page.getByTestId('analytics-current-occupancy')).toHaveText('9', { timeout: 40_000 });
  await expect(page.getByTestId('analytics-total-entries')).toHaveText('+9');
  // The five-minute window is the figure that says what is happening now.
  await expect(page.getByTestId('analytics-recent-entries')).toHaveText('+9');
  await expect(page.getByTestId('analytics-recent-net')).toHaveText('+9');

  // And a falling gauge must read as falling, not as an unsigned number.
  await adjustSpaceOccupancy(session, topo.eventId, topo.siteSpaceId, 6, 'Départs RC2B');

  await expect(page.getByTestId('analytics-current-occupancy')).toHaveText('6', { timeout: 40_000 });
  await expect(page.getByTestId('analytics-total-exits')).toHaveText('−3');
  await expect(page.getByTestId('analytics-recent-net')).toHaveText('+6');
});

test('l’écran de statistiques n’affiche jamais l’extérieur comme une zone vide', async ({ page }) => {
  const session = await getAdminSession();
  const topo = await liveEventWithCheckpoint(session, 'RC2B Zones Analytiques');
  await adjustSpaceOccupancy(session, topo.eventId, topo.siteSpaceId, 3, 'Recalage zones RC2B');

  await loginAsAdmin(page);
  await page.goto(`/admin/events/${topo.eventId}/analytics`);

  const zones = page.locator('section').filter({
    has: page.getByRole('heading', { name: /Répartition par zone/i }),
  });
  await expect(zones.getByText('Site', { exact: true })).toBeVisible({ timeout: 20_000 });
  // The `external` sentinel holds no people by construction; showing it
  // beside real zones would read as "the outside is empty".
  await expect(zones.getByText('Extérieur', { exact: true })).toHaveCount(0);
});
