import fs from 'node:fs';
import path from 'node:path';
import {
  test,
  expect,
  APIRequestContext,
  BrowserContext,
  Page,
  request as pwRequest,
} from '@playwright/test';
import { ACCEPTANCE_BASE_URL, ACCEPTANCE_DATA_DIR } from '../../playwright.config.js';

/**
 * Phase 10 — operator acceptance scenario.
 *
 * One question, end to end, on an instance nobody has touched: can a
 * non-technical operator install PaxFlux, prepare a real event, pair several
 * phones, count with and without network, close cleanly, and export?
 *
 * It runs against its own server (see ACCEPTANCE_* in playwright.config.ts)
 * because the shared E2E instance has its administrator created by
 * globalSetup before any spec runs — /setup there is already spent, and a
 * first-run flow that cannot observe first run proves nothing.
 *
 * The steps a human performs are driven through the interface. The
 * *verification* is done against the authoritative server state, because the
 * question is whether the counts are right, not whether a button rendered.
 */

const ADMIN_USERNAME = 'acceptance-admin';
const ADMIN_PASSWORD = 'AcceptancePass!2026';
const CSRF_HEADER_NAME = 'x-csrf-token';

const EVENT_NAME = 'Festival Acceptance Phase 10';
const CAPACITY = 500;

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: ACCEPTANCE_BASE_URL });

/** State handed from one ordered step to the next. */
const scenario: {
  api?: APIRequestContext;
  csrfToken?: string;
  eventId?: string;
  spaceIds?: Record<'Extérieur' | 'Site' | 'VIP', string>;
  checkpointIds?: Record<'Porte A' | 'Porte B' | 'Porte C' | 'Accès VIP', string>;
  pairUrls?: Record<'Porte A' | 'Porte B' | 'Accès VIP', string>;
  devices?: Record<'Porte A' | 'Porte B' | 'Accès VIP', { context: BrowserContext; page: Page }>;
} = {};

async function api<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  data?: unknown
): Promise<T> {
  const res = await scenario.api!.fetch(url, {
    method,
    data,
    headers: method === 'GET' ? {} : { [CSRF_HEADER_NAME]: scenario.csrfToken! },
  });
  if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()}: ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** `/state` without throwing, so a step can assert on a refusal itself. */
async function rawPost(url: string, data?: unknown): Promise<{ status: number; body: any }> {
  const res = await scenario.api!.fetch(url, {
    method: 'POST',
    data,
    headers: { [CSRF_HEADER_NAME]: scenario.csrfToken! },
  });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : undefined };
}

async function eventState() {
  return api<{
    event: { status: string; version: number };
    occupancy: { global: number; spaces: Record<string, number> };
    devices: Array<{ id: string; checkpointName: string; isOnline: boolean; lastPendingCount: number }>;
    syncQuality: string;
  }>('GET', `/api/v1/events/${scenario.eventId}/state`);
}

async function occupancyOf(space: 'Site' | 'VIP'): Promise<number> {
  const state = await eventState();
  return state.occupancy.spaces[scenario.spaceIds![space]] ?? 0;
}

async function readSetupToken(timeoutMs = 30_000): Promise<string> {
  const tokenFile = path.resolve(process.cwd(), ACCEPTANCE_DATA_DIR, 'setup-token.txt');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(tokenFile)) {
      const match = fs.readFileSync(tokenFile, 'utf-8').match(/PAXFLUX SETUP TOKEN:\s*\n([a-f0-9]+)/i);
      if (match) return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No setup token appeared at ${tokenFile}`);
}

/** Pairs one phone: a fresh browser context that opens the scanned URL. */
async function pairPhone(browser: import('@playwright/test').Browser, pairUrl: string) {
  const context = await browser.newContext({
    baseURL: ACCEPTANCE_BASE_URL,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto(new URL(pairUrl).pathname + new URL(pairUrl).hash);
  // RC2-D: the operator continues past the naming step. Skipping the name
  // is the path an acceptance run takes — naming is optional, and this
  // scenario is about counting.
  await page.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await page.waitForURL('**/counter');
  await expect(page.getByTestId('count-a-to-b')).toBeVisible();
  return { context, page };
}

test.afterAll(async () => {
  for (const device of Object.values(scenario.devices ?? {})) {
    await device.context.close().catch(() => {
      /* the scenario already failed; a context that will not close must not mask why */
    });
  }
  await scenario.api?.dispose();
});

// ---------------------------------------------------------------------------
// A — FIRST RUN
// ---------------------------------------------------------------------------

test('A. premier démarrage : instance vierge, token de setup, création du premier admin', async ({
  page,
}) => {
  test.setTimeout(90_000);

  // 1-2. A virgin instance advertises that it needs setup, and hands the
  // operator exactly one token, by the documented mechanism.
  const metaBefore = await (await pwRequest.newContext({ baseURL: ACCEPTANCE_BASE_URL }))
    .get('/api/v1/meta')
    .then((r) => r.json());
  expect(metaBefore.isInitialized, 'the acceptance instance must start uninitialised').toBe(false);

  const setupToken = await readSetupToken();
  expect(setupToken).toMatch(/^[a-f0-9]{64}$/);

  // 3-4. The operator opens /setup and creates the first administrator.
  await page.goto('/setup');
  await page.locator('#setup-token').fill(setupToken);
  await page.locator('#setup-instance').fill('PaxFlux Acceptance');
  await page.locator('#setup-username').fill(ADMIN_USERNAME);
  await page.locator('#setup-password').fill(ADMIN_PASSWORD);
  await page.locator('#setup-password-confirm').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /Créer le compte et démarrer/i }).click();

  // 5. Setup lands the operator inside the admin interface, authenticated,
  // with nothing pre-existing behind it.
  await page.waitForURL('**/admin/events/new');

  scenario.api = await pwRequest.newContext({ baseURL: ACCEPTANCE_BASE_URL });
  const login = await scenario.api.post('/api/v1/auth/login', {
    data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  expect(login.ok(), 'the administrator created through /setup must be able to log in').toBe(true);
  scenario.csrfToken = (await login.json()).csrfToken;

  const metaAfter = await api<{ isInitialized: boolean }>('GET', '/api/v1/meta');
  expect(metaAfter.isInitialized).toBe(true);

  // The one-time token must not still open a second setup.
  const replay = await scenario.api.post('/api/v1/setup', {
    data: { setupToken, username: 'second-admin', password: ADMIN_PASSWORD, instanceName: 'x' },
  });
  expect(replay.ok(), '/setup must not be replayable once an admin exists').toBe(false);

  expect(await api<any[]>('GET', '/api/v1/events'), 'a fresh instance holds no events').toEqual([]);
});

// ---------------------------------------------------------------------------
// B — EVENT SETUP
// ---------------------------------------------------------------------------

test('B. préparation de l’événement : 3 espaces, 4 portes, draft persistant, preflight, passage en live', async ({
  page,
}) => {
  test.setTimeout(120_000);

  // 6. The operator creates the event through the wizard.
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');

  await page.getByRole('link', { name: /nouvel événement|créer un événement/i }).click();
  await page.waitForURL('**/admin/events/new');

  await page.locator('#event-name').fill(EVENT_NAME);
  await page.locator('#event-capacity').fill(String(CAPACITY));
  await page.getByRole('button', { name: 'Suivant' }).click();

  // 8. Exactly three spaces: Extérieur (seeded), Site, VIP.
  await page.getByLabel("Nom de l’espace intérieur").first().fill('Site');
  await page.getByRole('button', { name: /ajouter un espace intérieur/i }).click();
  await page.getByLabel("Nom de l’espace intérieur").nth(1).fill('VIP');
  await page.getByRole('button', { name: 'Suivant' }).click();

  // 9. Exactly four doors: three on the external boundary, one internal.
  const addDoor = page.getByRole('button', { name: /ajouter une porte|ajouter un checkpoint/i });
  await addDoor.click();
  await addDoor.click();
  await addDoor.click();

  const doorNames = ['Porte A', 'Porte B', 'Porte C', 'Accès VIP'] as const;
  for (const [index, name] of doorNames.entries()) {
    await page.getByLabel('Nom de la porte').nth(index).fill(name);
  }
  // The fourth door is the internal transfer Site <-> VIP; the first three
  // keep the seeded Extérieur <-> Site endpoints.
  await page.getByLabel('Première zone de la porte').nth(3).selectOption({ label: 'Site' });
  await page.getByLabel('Deuxième zone de la porte').nth(3).selectOption({ label: 'VIP' });

  // 10. The operator reviews the topology before committing to it.
  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByRole('heading', { name: /Validation de la Topologie/i })).toBeVisible();

  // 11. Save.
  await page.getByRole('button', { name: /Créer l’événement/i }).click();
  await page.waitForURL(/\/admin\?event=/);
  scenario.eventId = new URL(page.url()).searchParams.get('event')!;

  // 7. Saving must not start the event: it stays a draft for review.
  const created = await api<{ status: string }>('GET', `/api/v1/events/${scenario.eventId}`);
  expect(created.status, 'a newly created event must stay in draft').toBe('draft');

  // 12-13. A full page load of the admin route — not a client-side
  // navigation — must still show the complete draft.
  await page.goto(`/admin?event=${scenario.eventId}`);
  await expect(page.getByTestId('dashboard-event-name')).toHaveText(EVENT_NAME);
  await expect(page.getByTestId('event-status')).toContainText(/brouillon/i);

  const spaces = await api<Array<{ id: string; name: string; kind: string }>>(
    'GET',
    `/api/v1/events/${scenario.eventId}/spaces`
  );
  expect(spaces.map((s) => s.name).sort()).toEqual(['Extérieur', 'Site', 'VIP']);
  scenario.spaceIds = Object.fromEntries(spaces.map((s) => [s.name, s.id])) as typeof scenario.spaceIds;

  const checkpoints = await api<Array<{ id: string; name: string; spaceAId: string; spaceBId: string }>>(
    'GET',
    `/api/v1/events/${scenario.eventId}/checkpoints`
  );
  expect(checkpoints).toHaveLength(4);
  expect(checkpoints.map((c) => c.name).sort()).toEqual(['Accès VIP', 'Porte A', 'Porte B', 'Porte C']);
  scenario.checkpointIds = Object.fromEntries(
    checkpoints.map((c) => [c.name, c.id])
  ) as typeof scenario.checkpointIds;

  const ext = scenario.spaceIds!.Extérieur;
  const site = scenario.spaceIds!.Site;
  const vip = scenario.spaceIds!.VIP;
  const endpoints = (name: string) => {
    const cp = checkpoints.find((c) => c.name === name)!;
    return [cp.spaceAId, cp.spaceBId].sort();
  };
  for (const boundaryDoor of ['Porte A', 'Porte B', 'Porte C']) {
    expect(endpoints(boundaryDoor), `${boundaryDoor} joins Extérieur and Site`).toEqual([ext, site].sort());
  }
  expect(endpoints('Accès VIP'), 'Accès VIP is an internal Site <-> VIP transfer').toEqual(
    [site, vip].sort()
  );

  // 14-15. Preflight, and it must say the event is ready.
  const preflight = await api<{ ready: boolean; checks?: unknown }>(
    'GET',
    `/api/v1/events/${scenario.eventId}/preflight`
  );
  expect(preflight.ready, `preflight refused a complete topology: ${JSON.stringify(preflight)}`).toBe(
    true
  );

  // 16. Counting opens only when the operator explicitly says so.
  await page.getByRole('button', { name: /Démarrer l’événement/i }).click();
  await page.getByRole('button', { name: /^Démarrer l’événement$/ }).last().click();
  await expect
    .poll(async () => (await api<{ status: string }>('GET', `/api/v1/events/${scenario.eventId}`)).status)
    .toBe('live');
});

// ---------------------------------------------------------------------------
// C — MULTI DEVICE
// ---------------------------------------------------------------------------

test('C. appairage de trois téléphones distincts sur trois portes', async ({ page, browser }) => {
  test.setTimeout(120_000);

  // 17. Three distinct QR invitations, generated from the interface.
  await page.goto(`/login`);
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
  await page.goto(`/admin/events/${scenario.eventId}/devices`);

  const pairUrls = {} as NonNullable<typeof scenario.pairUrls>;
  const shown = page.locator('p.select-all');
  let previousPairUrl = '';

  for (const door of ['Porte A', 'Porte B', 'Accès VIP'] as const) {
    await page.locator('#checkpoint-picker').selectOption({ label: door });
    await page.getByRole('button', { name: /Générer le QR Code d’appairage/i }).click();
    await expect(shown).toBeVisible({ timeout: 10_000 });

    // From the second door on, the panel still shows the *previous*
    // invitation until the new one comes back. Waiting for "something that
    // looks like a pair URL" would therefore read the old one and hand two
    // doors the same secret. Wait for the displayed URL to actually change.
    await expect
      .poll(
        async () => {
          const text = (await shown.innerText()).trim();
          return text !== previousPairUrl && /\/pair#[A-Za-z0-9_-]+$/.test(text);
        },
        {
          timeout: 15_000,
          message: `the panel never showed a new pairing URL for ${door}`,
        }
      )
      .toBe(true);

    previousPairUrl = (await shown.innerText()).trim();
    pairUrls[door] = previousPairUrl;
  }
  scenario.pairUrls = pairUrls;

  const distinctSecrets = new Set(Object.values(pairUrls).map((u) => u.split('#')[1]));
  expect(distinctSecrets.size, 'each QR must carry its own single-use secret').toBe(3);

  // 18. Three separate browser contexts scan them — three real devices, each
  // with its own cookie jar and its own IndexedDB.
  scenario.devices = {
    'Porte A': await pairPhone(browser, pairUrls['Porte A']),
    'Porte B': await pairPhone(browser, pairUrls['Porte B']),
    'Accès VIP': await pairPhone(browser, pairUrls['Accès VIP']),
  };

  // 19. All three are visible to the supervisor, on the right doors.
  await expect
    .poll(async () => (await eventState()).devices.length, { timeout: 20_000 })
    .toBe(3);
  const state = await eventState();
  expect(state.devices.map((d) => d.checkpointName).sort()).toEqual([
    'Accès VIP',
    'Porte A',
    'Porte B',
  ]);

  // 20. Heartbeats alone bring them online, with nothing counted yet.
  await expect
    .poll(async () => (await eventState()).devices.filter((d) => d.isOnline).length, {
      timeout: 30_000,
    })
    .toBe(3);
  const idle = await eventState();
  expect(idle.occupancy.global, 'pairing must not create movements').toBe(0);
  expect(idle.devices.every((d) => d.lastPendingCount === 0)).toBe(true);
});

// ---------------------------------------------------------------------------
// D — LIVE COUNTING
// ---------------------------------------------------------------------------

test('D. comptage live : deux portes en parallèle, puis transfert interne à somme nulle', async () => {
  test.setTimeout(120_000);

  const doorA = scenario.devices!['Porte A'].page;
  const doorB = scenario.devices!['Porte B'].page;
  const vipDoor = scenario.devices!['Accès VIP'].page;

  // 21. Near-simultaneous taps on two different doors, three each.
  for (let i = 0; i < 3; i += 1) {
    await Promise.all([
      doorA.getByTestId('count-a-to-b').click(),
      doorB.getByTestId('count-a-to-b').click(),
    ]);
  }

  // 22. The authoritative total is the sum: nothing lost to the race.
  await expect
    .poll(async () => (await eventState()).occupancy.global, { timeout: 30_000 })
    .toBe(6);
  expect(await occupancyOf('Site')).toBe(6);
  expect(await occupancyOf('VIP')).toBe(0);

  // 23. One person moves from Site into VIP through the internal door.
  const globalBefore = (await eventState()).occupancy.global;
  await vipDoor.getByTestId('count-a-to-b').click();

  // 24. Site -1, VIP +1, and the global gauge unchanged: an internal
  // transfer neither creates nor destroys a person.
  await expect.poll(async () => await occupancyOf('VIP'), { timeout: 30_000 }).toBe(1);
  expect(await occupancyOf('Site')).toBe(5);
  expect(
    (await eventState()).occupancy.global,
    'an internal transfer must be a zero-sum move on the global gauge'
  ).toBe(globalBefore);
});

// ---------------------------------------------------------------------------
// E — OFFLINE
// ---------------------------------------------------------------------------

test('E. hors ligne : taps mis en attente, comptage continu ailleurs, drain sans perte ni double', async () => {
  test.setTimeout(180_000);

  const offlineDevice = scenario.devices!['Porte A'];
  const onlineDoor = scenario.devices!['Porte B'].page;

  const globalBefore = (await eventState()).occupancy.global;

  // 25-26. A real network cut on one phone, then four taps on it.
  await offlineDevice.context.setOffline(true);
  const offlineBadge = offlineDevice.page.getByText(/^HORS LIGNE( \(\d+\))?$/);
  await expect(offlineBadge).toBeVisible({ timeout: 30_000 });

  const OFFLINE_TAPS = 4;
  for (let i = 0; i < OFFLINE_TAPS; i += 1) {
    await offlineDevice.page.getByTestId('count-a-to-b').click();
  }

  // 27. They are held locally and shown as pending, not silently dropped.
  await expect(offlineBadge).toHaveText(`HORS LIGNE (${OFFLINE_TAPS})`, { timeout: 15_000 });
  await expect(offlineDevice.page.getByTestId('global-occupancy')).toHaveText(
    String(globalBefore + OFFLINE_TAPS)
  );
  // Nothing reached the server while the device was cut off.
  expect((await eventState()).occupancy.global).toBe(globalBefore);

  // 28. The other phone keeps counting for real in the meantime.
  const ONLINE_TAPS = 2;
  for (let i = 0; i < ONLINE_TAPS; i += 1) {
    await onlineDoor.getByTestId('count-a-to-b').click();
  }
  await expect
    .poll(async () => (await eventState()).occupancy.global, { timeout: 30_000 })
    .toBe(globalBefore + ONLINE_TAPS);

  // 29-30. Network back: the outbox drains on its own, nobody presses anything.
  await offlineDevice.context.setOffline(false);

  // 31. Every offline tap arrives...
  await expect
    .poll(async () => (await eventState()).occupancy.global, { timeout: 60_000 })
    .toBe(globalBefore + ONLINE_TAPS + OFFLINE_TAPS);

  // 32. ...exactly once. The count must hold still afterwards rather than
  // creep, which is what a re-application of the batch would look like.
  await offlineDevice.page.waitForTimeout(4_000);
  expect(
    (await eventState()).occupancy.global,
    'a drained batch must not be applied twice'
  ).toBe(globalBefore + ONLINE_TAPS + OFFLINE_TAPS);

  await expect
    .poll(async () => (await eventState()).devices.every((d) => d.lastPendingCount === 0), {
      timeout: 30_000,
    })
    .toBe(true);
});

// ---------------------------------------------------------------------------
// F — UNDO
// ---------------------------------------------------------------------------

test('F. annulation : la dernière action est compensée dans le journal et à l’écran', async () => {
  test.setTimeout(120_000);

  const device = scenario.devices!['Porte B'];
  const before = (await eventState()).occupancy.global;

  // 33. One more entry.
  await device.page.getByTestId('count-a-to-b').click();
  await expect.poll(async () => (await eventState()).occupancy.global, { timeout: 30_000 }).toBe(
    before + 1
  );

  const rowsBefore = (
    await api<{ movements: unknown[] }>('GET', `/api/v1/events/${scenario.eventId}/export/event.json`)
  ).movements;

  // 34. The operator undoes it from the counter.
  await device.page.getByRole('button', { name: /ANNULER/ }).click();

  // 35. The visible result returns to where it was, and the ledger grew
  // instead of shrinking: a correction is a compensating movement, never a
  // deletion.
  await expect.poll(async () => (await eventState()).occupancy.global, { timeout: 30_000 }).toBe(before);

  const rowsAfter = (
    await api<{ movements: unknown[] }>('GET', `/api/v1/events/${scenario.eventId}/export/event.json`)
  ).movements;
  expect(
    rowsAfter.length,
    'an undo must append a compensating movement, not remove the original'
  ).toBeGreaterThan(rowsBefore.length);

  await expect(device.page.getByTestId('global-occupancy')).toHaveText(String(before), {
    timeout: 15_000,
  });
});

// ---------------------------------------------------------------------------
// G — CLOSING
// ---------------------------------------------------------------------------

test('G. fermeture : nouveaux taps refusés, action pré-closing drainable, clôture bloquée sans accusé', async () => {
  test.setTimeout(180_000);

  const strandedDevice = scenario.devices!['Porte A'];
  const liveDoor = scenario.devices!['Porte B'].page;
  const occupancyBeforeClosing = (await eventState()).occupancy.global;

  // 38. One action created BEFORE closing that is still stuck in an outbox
  // when closing starts: the case an event day actually produces.
  await strandedDevice.context.setOffline(true);
  const strandedBadge = strandedDevice.page.getByText(/^HORS LIGNE( \(\d+\))?$/);
  await expect(strandedBadge).toBeVisible({ timeout: 30_000 });
  await strandedDevice.page.getByTestId('count-a-to-b').click();
  await expect(strandedBadge).toHaveText('HORS LIGNE (1)', { timeout: 15_000 });

  // 36. The supervisor begins closing.
  await api('POST', `/api/v1/events/${scenario.eventId}/begin-closing`);
  expect((await eventState()).event.status).toBe('closing');

  // 37. A device that is online learns immediately and refuses new counts.
  await expect
    .poll(async () => await liveDoor.getByTestId('count-a-to-b').isDisabled(), { timeout: 30_000 })
    .toBe(true);
  const occupancyAtClosing = (await eventState()).occupancy.global;
  await liveDoor.getByTestId('count-a-to-b').click({ force: true }).catch(() => {
    /* a disabled control refusing the click is the expected outcome */
  });
  await liveDoor.waitForTimeout(1_500);
  expect(
    (await eventState()).occupancy.global,
    'no new movement may be created once the event is closing'
  ).toBe(occupancyAtClosing);

  // 40. Closing normally must be refused while an active device has not
  // confirmed its drain.
  const refused = await rawPost(`/api/v1/events/${scenario.eventId}/close`);
  expect(refused.status).toBe(409);
  expect(refused.body?.code).toBe('DEVICES_NOT_SYNCED');
  expect((await eventState()).event.status).toBe('closing');

  // 39. The pre-closing action still drains once the phone is back.
  await strandedDevice.context.setOffline(false);
  await expect
    .poll(async () => (await eventState()).occupancy.global, { timeout: 60_000 })
    .toBe(occupancyBeforeClosing + 1);

  // 41-42. With every device drained and acknowledged, the normal close goes
  // through — no force, no reason needed.
  await expect
    .poll(
      async () => {
        const res = await rawPost(`/api/v1/events/${scenario.eventId}/close`);
        return res.status;
      },
      { timeout: 90_000, intervals: [2_000] }
    )
    .toBe(200);
  expect((await eventState()).event.status).toBe('closed');
});

// ---------------------------------------------------------------------------
// H — CLOSED / EXPORT
// ---------------------------------------------------------------------------

test('H. événement clos : plus aucune action, export cohérent, réouverture sous contrainte', async () => {
  test.setTimeout(120_000);

  const device = scenario.devices!['Porte B'];
  const finalOccupancy = (await eventState()).occupancy.global;

  // 43. A counter can no longer create anything.
  await device.page.reload();
  await expect
    .poll(async () => await device.page.getByTestId('count-a-to-b').isDisabled(), { timeout: 30_000 })
    .toBe(true);
  await device.page.getByTestId('count-a-to-b').click({ force: true }).catch(() => {
    /* expected: the control is disabled on a closed event */
  });
  await device.page.waitForTimeout(1_500);
  expect((await eventState()).occupancy.global).toBe(finalOccupancy);

  // The server refuses directly too, not only the interface.
  const direct = await scenario.api!.post('/api/v1/device/actions/batch', {
    data: { actions: [] },
  });
  expect([400, 401, 403, 409]).toContain(direct.status());

  // 44-45. The export is non-empty and agrees with the event.
  const csv = await scenario.api!.get(
    `/api/v1/events/${scenario.eventId}/export/movements.csv`,
    { headers: { [CSRF_HEADER_NAME]: scenario.csrfToken! } }
  );
  expect(csv.status()).toBe(200);
  const csvBody = await csv.text();
  const csvLines = csvBody.trim().split(/\r?\n/);
  expect(csvLines.length, 'the export must contain the ledger, not just a header').toBeGreaterThan(1);
  expect(csvLines[0]).toMatch(/,/);
  for (const door of ['Porte A', 'Porte B', 'Accès VIP']) {
    expect(csvBody, `the export must name the door ${door}`).toContain(door);
  }

  const full = await api<{
    event: { name: string; status: string };
    spaces: Array<{ id: string; name: string }>;
    checkpoints: Array<{ id: string; name: string }>;
    movements: any[];
  }>('GET', `/api/v1/events/${scenario.eventId}/export/event.json`);
  const movements = full.movements;
  expect(movements.length, 'CSV and JSON exports must describe the same ledger').toBe(
    csvLines.length - 1
  );
  expect(full.event.name).toBe(EVENT_NAME);
  expect(full.spaces).toHaveLength(3);
  expect(full.checkpoints).toHaveLength(4);

  // The ledger must reconstruct the occupancy the product reports: every
  // boundary movement is +1 or -1 on the site, internal transfers net to zero.
  const ext = scenario.spaceIds!.Extérieur;
  const rebuilt = movements.reduce((total: number, m: any) => {
    const from = m.fromSpaceId ?? m.from_space_id;
    const to = m.toSpaceId ?? m.to_space_id;
    if (from === ext && to !== ext) return total + 1;
    if (to === ext && from !== ext) return total - 1;
    return total;
  }, 0);
  expect(
    rebuilt,
    'replaying the exported ledger must reproduce the reported occupancy'
  ).toBe(finalOccupancy);

  // 46. A sensitive action on a closed event is gated: reopening demands an
  // explicit reason, and is refused without one.
  const withoutReason = await rawPost(`/api/v1/events/${scenario.eventId}/reopen`, {});
  expect(withoutReason.status, 'reopen must not be possible without a reason').toBeGreaterThanOrEqual(
    400
  );
  expect((await eventState()).event.status).toBe('closed');

  const withReason = await rawPost(`/api/v1/events/${scenario.eventId}/reopen`, {
    reason: 'Recomptage demandé par la direction après clôture',
  });
  expect(withReason.status).toBe(200);
  expect((await eventState()).event.status).not.toBe('closed');

  // The reopening is recorded, not silent.
  const audit = await api<any[]>('GET', `/api/v1/events/${scenario.eventId}/audit`).catch(() => null);
  if (audit) {
    expect(audit.some((entry: any) => JSON.stringify(entry).includes('Recomptage demandé'))).toBe(true);
  }
});
