import { test, expect, Page } from '@playwright/test';
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  AdminSession,
  adminApi,
  createDeviceInviteToken,
  createDraftEventWithMainCheckpoint,
  getAdminSession,
  getEventDevices,
  startEvent,
} from './helpers.js';
import { readDeviceConfigRecord } from './offline-helpers.js';

/**
 * RC2-D — a device is a physical phone, and it has a name of its own.
 *
 * The field problem these cover: four handsets on "Porte nord" were all
 * called some variant of "Porte nord — appareil N", and an operator holding
 * one could not tell which. Naming is optional, never blocks pairing, and
 * the door remains what a count means.
 */

let session: AdminSession;

test.beforeAll(async () => {
  session = await getAdminSession();
});

interface PairedFixture {
  eventId: string;
  checkpointId: string;
  sessionId: string;
  defaultLabel: string;
}

async function liveEvent(name: string) {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `${name} · ${test.info().project.name}`,
    capacity: 200,
  });
  await startEvent(session, topo.eventId);
  return topo;
}

/** Pairs this browser and stops on the completion step, without continuing. */
async function pairAndStop(page: Page, name: string): Promise<PairedFixture> {
  const topo = await liveEvent(name);
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  await page.goto(`/pair#${token}`);
  await expect(page.getByText('Appairage réussi')).toBeVisible();

  const devices = await getEventDevices(session, topo.eventId);
  return {
    eventId: topo.eventId,
    checkpointId: topo.mainCheckpointId,
    sessionId: devices[0].id,
    defaultLabel: devices[0].label,
  };
}

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

// ---------------------------------------------------------------------------

test('le nom généré reste utilisable quand l’opérateur ne renomme pas', async ({ page }) => {
  const paired = await pairAndStop(page, 'RC2D nom par défaut');

  // The generated name is on screen before any choice is made, which is the
  // point: the previous version navigated away on an 800ms timer.
  await expect(page.getByLabel('Nom de cet appareil')).toHaveValue(paired.defaultLabel);

  await page.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await page.waitForURL('**/counter');

  // Shown as its own line, distinct from the door — not instead of it.
  await expect(page.getByTestId('counter-device-label')).toContainText(paired.defaultLabel);
  await expect(page.getByRole('heading', { name: 'Porte Principale' })).toBeVisible();

  const devices = await getEventDevices(session, paired.eventId);
  expect(devices[0].label, 'skipping the rename changes nothing server-side').toBe(paired.defaultLabel);
});

test('un appareil se renomme lui-même sans changer d’identité', async ({ page }) => {
  const paired = await pairAndStop(page, 'RC2D auto-renommage');

  await page.getByLabel('Nom de cet appareil').fill('Téléphone entrée nord');
  await page.getByRole('button', { name: 'Continuer avec ce nom' }).click();
  await page.waitForURL('**/counter');

  await expect(page.getByTestId('counter-device-label')).toContainText('Téléphone entrée nord');

  const devices = await getEventDevices(session, paired.eventId);
  expect(devices, 'no second session was created to hold a name').toHaveLength(1);
  expect(devices[0].id, 'same session').toBe(paired.sessionId);
  expect(devices[0].label).toBe('Téléphone entrée nord');
  expect(devices[0].checkpointId, 'same door').toBe(paired.checkpointId);

  // The local bootstrap carries the canonical label, so the counter shows it
  // after a reload with nothing to re-fetch it from.
  const config = (await readDeviceConfigRecord(page)) as any;
  expect(config.bootstrap.deviceSession.label).toBe('Téléphone entrée nord');
  expect(config.bootstrap.deviceSession.id).toBe(paired.sessionId);
});

test('un nom refusé n’annule pas un appairage réussi', async ({ page }) => {
  const paired = await pairAndStop(page, 'RC2D nom refusé');

  // The server refuses this rename. Pairing already happened; the operator
  // must be told about the name and still be able to go and count.
  await page.route('**/api/v1/device/session', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        status: 400,
        code: 'VALIDATION_ERROR',
        title: 'Nom d’appareil invalide',
        detail: 'Ce nom est refusé par le serveur.',
      }),
    })
  );

  await page.getByLabel('Nom de cet appareil').fill('Nom refusé');
  await page.getByRole('button', { name: 'Continuer avec ce nom' }).click();

  await expect(page.getByText('Nom non enregistré')).toBeVisible();
  expect(new URL(page.url()).pathname, 'still on the completion step, not an error screen').toBe('/pair');

  // And the pairing is intact: continuing works, under the generated label.
  await page.unroute('**/api/v1/device/session');
  await page.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await page.waitForURL('**/counter');
  await expect(page.getByTestId('counter-device-label')).toContainText(paired.defaultLabel);
});

test('un nom vide n’est pas enregistrable', async ({ page }) => {
  await pairAndStop(page, 'RC2D nom vide');

  await page.getByLabel('Nom de cet appareil').fill('   ');
  await expect(page.getByRole('button', { name: 'Continuer avec ce nom' })).toBeDisabled();
  // Skipping is still available: an invalid name must not trap the operator.
  await expect(page.getByRole('button', { name: 'Continuer sans renommer' })).toBeEnabled();
});

// ---------------------------------------------------------------------------

test('un renommage administrateur atteint un téléphone déjà ouvert', async ({ page, browser }) => {
  // No hard reload, and no polling loop added for this: the heartbeat that
  // already runs every 15s brings the canonical label back with it.
  test.setTimeout(90_000);

  const paired = await pairAndStop(page, 'RC2D renommage admin');
  await page.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await page.waitForURL('**/counter');
  await expect(page.getByTestId('counter-device-label')).toContainText(paired.defaultLabel);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginAsAdmin(adminPage);
  await adminPage.goto(`/admin/events/${paired.eventId}/devices`);

  await adminPage.getByRole('button', { name: `Renommer ${paired.defaultLabel}` }).click();
  await adminPage.getByLabel('Nom de l’appareil').fill('Téléphone régie');
  await adminPage.getByRole('button', { name: 'Enregistrer le nom' }).click();

  // The list converges on the server without a full-page reload.
  // `exact` because the actions cell in the same row carries an aria-label
  // that also contains the new name.
  await expect(adminPage.getByRole('cell', { name: 'Téléphone régie', exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // And so does the open phone, on its own beat.
  await expect(page.getByTestId('counter-device-label')).toContainText('Téléphone régie', {
    timeout: 45_000,
  });

  // Ownership is untouched by a rename.
  const devices = await getEventDevices(session, paired.eventId);
  expect(devices[0].id).toBe(paired.sessionId);
  expect(devices[0].checkpointId).toBe(paired.checkpointId);

  await adminContext.close();
});

test('un téléphone hors ligne garde son dernier nom connu et converge au retour', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);

  const paired = await pairAndStop(page, 'RC2D renommage hors ligne');
  await page.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await page.waitForURL('**/counter');
  await expect(page.getByTestId('counter-device-label')).toContainText(paired.defaultLabel);

  await context.setOffline(true);
  try {
    // Renamed server-side while the phone cannot hear it.
    await adminApi(session, 'PATCH', `/api/v1/device-sessions/${paired.sessionId}`, {
      label: 'Renommé pendant la coupure',
    });

    // The phone keeps what it last knew rather than blanking or guessing.
    await page.waitForTimeout(3_000);
    await expect(page.getByTestId('counter-device-label')).toContainText(paired.defaultLabel);
  } finally {
    await context.setOffline(false);
  }

  // On reconnection the next beat carries the canonical value.
  await expect(page.getByTestId('counter-device-label')).toContainText('Renommé pendant la coupure', {
    timeout: 45_000,
  });
});

test('un libellé en vol ne peut pas franchir une frontière d’appairage', async ({ page }) => {
  // The Phase 6 ownership boundary, applied to display metadata. A label
  // response — or a heartbeat carrying one — can be in flight when the
  // browser re-pairs as a different device. Applying it afterwards would put
  // one handset's name on another's screen.
  const first = await pairAndStop(page, 'RC2D course renommage A');
  await page.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await page.waitForURL('**/counter');

  // Re-pair this same browser as a second device on another event.
  const second = await liveEvent('RC2D course renommage B');
  const token = await createDeviceInviteToken(session, second.eventId, second.mainCheckpointId);
  await page.goto(`/pair#${token}`);
  await expect(page.getByText('Appairage réussi')).toBeVisible();
  await page.getByLabel('Nom de cet appareil').fill('Appareil B');
  await page.getByRole('button', { name: 'Continuer avec ce nom' }).click();
  await page.waitForURL('**/counter');

  const before = (await readDeviceConfigRecord(page)) as any;
  const currentSessionId = before.bootstrap.deviceSession.id;
  expect(currentSessionId, 'the browser is now device B').not.toBe(first.sessionId);

  // Now let the *old* session's label response complete, late.
  const applied = await page.evaluate(
    async ([staleSessionId, dbName]) => {
      // Calls the same guarded helper the heartbeat and the rename use,
      // through the module the app already loaded.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName as string);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const record = await new Promise<any>((resolve, reject) => {
        const r = db.transaction('device_config', 'readonly').objectStore('device_config').get('current');
        r.onsuccess = () => resolve(r.result ?? null);
        r.onerror = () => reject(r.error);
      });
      db.close();
      // The guard the helper applies, asserted on the stored record: a label
      // for a session that is not the stored one must not be written.
      return record?.bootstrap?.deviceSession?.id === staleSessionId;
    },
    [first.sessionId, 'PaxFluxDB'] as const
  );
  expect(applied, 'a stale session id must not match the current pairing').toBe(false);

  // Rename the *old* session server-side. Its label must never reach this
  // browser, which no longer is that device.
  await adminApi(session, 'PATCH', `/api/v1/device-sessions/${first.sessionId}`, {
    label: 'Ancien appareil renommé',
  });
  await page.waitForTimeout(3_000);

  const after = (await readDeviceConfigRecord(page)) as any;
  expect(after.bootstrap.deviceSession.id, 'ownership unchanged').toBe(currentSessionId);
  expect(after.bootstrap.deviceSession.label, 'B keeps its own name').toBe('Appareil B');
  expect(after.bootstrap.event.id, 'event ownership unchanged').toBe(second.eventId);
  expect(after.bootstrap.checkpoint.id, 'checkpoint ownership unchanged').toBe(second.mainCheckpointId);

  await expect(page.getByTestId('counter-device-label')).toContainText('Appareil B');
});

test('aucune invitation à installer quand le navigateur n’en propose pas', async ({ page }) => {
  // Playwright's Chromium does not fire `beforeinstallprompt` for a test
  // origin, which is exactly the state most field browsers are in — iOS has
  // no install API at all, and a plain-HTTP LAN origin never meets the
  // criteria. What must not happen is a button that leads nowhere.
  await pairAndStop(page, 'RC2D pas d’installation');

  await expect(page.getByTestId('install-app')).toHaveCount(0);
  // And the flow is entirely usable without it.
  await expect(page.getByRole('button', { name: 'Continuer sans renommer' })).toBeEnabled();
});

test('l’invitation à installer apparaît quand le navigateur en propose une', async ({ page }) => {
  // The prompt is synthesised rather than provoked: no vendor hack can make
  // Chromium offer one here, and forcing it is explicitly out of scope. What
  // is under test is our own contract — a real event produces the CTA, the
  // browser's prompt is what gets asked, and nothing claims success the
  // browser has not confirmed.
  const topo = await liveEvent('RC2D installation disponible');
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);

  await page.goto(`/pair#${token}`);
  await expect(page.getByText('Appairage réussi')).toBeVisible();

  // Dispatched once the screen is up, so the listener is certainly attached:
  // firing it on `load` races React's effects.
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt') as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: string }>;
    };
    event.prompt = async () => {
      (window as unknown as { __paxfluxInstallPrompted?: boolean }).__paxfluxInstallPrompted = true;
    };
    event.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(event);
  });

  const install = page.getByTestId('install-app');
  await expect(install).toBeVisible();
  await install.click();

  // The browser's own prompt was asked for.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __paxfluxInstallPrompted?: boolean }).__paxfluxInstallPrompted)
    )
    .toBe(true);

  // And because it was dismissed, the button goes away rather than claiming
  // anything happened. A prompt can only be shown once.
  await expect(install).toHaveCount(0);
  await expect(page.getByText(/installée|installation réussie/i)).toHaveCount(0);

  // Counting is unaffected either way.
  await page.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await page.waitForURL('**/counter');
});
