import { test, expect, Page } from '@playwright/test';
import {
  AdminSession,
  createDeviceInviteToken,
  createDraftEventWithMainCheckpoint,
  getAdminSession,
  startEvent,
} from './helpers.js';
import { readOutbox } from './offline-helpers.js';

/**
 * RC2-E — `Tester la vibration`, and what it must not do.
 *
 * The field problem it answers: an operator whose phone never buzzed could
 * not tell a browser without the API (every iOS browser) from a handset with
 * haptics switched off, and a silent tap reads exactly like a missed one. So
 * pairing — the one moment the phone is in hand and not yet at a door —
 * offers a diagnostic.
 *
 * The invariant these tests defend is the other half of that: counting never
 * depends on vibration succeeding, and a *diagnostic* must not have side
 * effects. It re-pairs nothing, records nothing and navigates nowhere.
 */

type VibrateMode = 'accept' | 'refuse' | 'throw' | 'absent';

let session: AdminSession;

test.beforeAll(async () => {
  session = await getAdminSession();
});

async function inviteToken(name: string): Promise<string> {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `${name} · ${test.info().project.name}`,
    capacity: 200,
  });
  await startEvent(session, topo.eventId);
  return createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
}

/**
 * Replaces `navigator.vibrate` before any application code runs.
 *
 * Installed as an init script rather than by patching after load, because
 * the module reads the API through `resolveVibrator` at call time and a
 * late patch would leave the first render observing the real one. The four
 * modes are the four things the platform actually does — including
 * `absent`, which is the majority of the mobile fleet and cannot be reached
 * on a Chromium runner any other way.
 */
async function stubVibration(page: Page, mode: VibrateMode): Promise<void> {
  await page.addInitScript((m: VibrateMode) => {
    const calls: unknown[] = [];
    (window as unknown as { __vibrateCalls: unknown[] }).__vibrateCalls = calls;

    if (m === 'absent') {
      // Redefined rather than deleted: `delete navigator.vibrate` leaves the
      // prototype's accessor in place in some builds, so the property would
      // still answer as a function.
      Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined });
      return;
    }

    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: number | number[]) => {
        calls.push(pattern);
        if (m === 'throw') throw new TypeError('vibration disabled by the user');
        return m === 'accept';
      },
    });
  }, mode);
}

const vibrateCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __vibrateCalls?: unknown[] }).__vibrateCalls ?? []);

async function pairAndStay(page: Page, name: string): Promise<void> {
  await page.goto(`/pair#${await inviteToken(name)}`);
  // Stops at the completion step on purpose: this is the screen under test.
  await expect(page.getByText('Appairage réussi')).toBeVisible();
}

test('une vibration acceptée est annoncée comme demandée, jamais comme ressentie', async ({ page }) => {
  await stubVibration(page, 'accept');
  await pairAndStay(page, 'RC2E vibration acceptée');

  await page.getByTestId('test-haptics').click();

  const result = page.getByTestId('haptic-result');
  await expect(result).toHaveAttribute('data-haptic-outcome', 'accepted');
  // `true` from the API means the request was taken, not that the motor
  // moved: a silent-mode phone returns it too. The copy must not promise
  // more than the platform reports.
  await expect(result).toContainText('Vibration demandée');
  await expect(result).toContainText('Si vous n’avez rien senti');

  expect(await vibrateCalls(page), 'the diagnostic really called the API').toEqual([[40, 60, 40]]);
});

test('une vibration refusée par le navigateur est dite refusée', async ({ page }) => {
  await stubVibration(page, 'refuse');
  await pairAndStay(page, 'RC2E vibration refusée');

  await page.getByTestId('test-haptics').click();

  await expect(page.getByTestId('haptic-result')).toHaveAttribute('data-haptic-outcome', 'refused');
  await expect(page.getByTestId('haptic-result')).toContainText('réglages du téléphone');
});

test('un navigateur sans API de vibration est un fait, pas une panne', async ({ page }) => {
  // Every iOS browser. The screen must say so plainly instead of reporting a
  // failure the operator would try to fix.
  await stubVibration(page, 'absent');
  await pairAndStay(page, 'RC2E vibration absente');

  await page.getByTestId('test-haptics').click();

  await expect(page.getByTestId('haptic-result')).toHaveAttribute('data-haptic-outcome', 'unsupported');
  await expect(page.getByTestId('haptic-result')).toContainText('iPhone');
  await expect(page.getByTestId('haptic-result')).toContainText('Le comptage fonctionne sans vibration');

  // And the claim is true: this handset pairs and counts exactly as any
  // other does, with no vibration API on the page at all.
  await page.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await page.waitForURL('**/counter');
  await page.getByTestId('count-a-to-b').click();
  await expect(page.getByTestId('global-occupancy')).toHaveText('1');
});

test('une API de vibration qui lève ne casse pas l’écran d’appairage', async ({ page }) => {
  // Firefox and some Android browsers throw when vibration is disabled. An
  // exception escaping here would take the completion step down and strand a
  // phone that is, in fact, already paired.
  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  await stubVibration(page, 'throw');
  await pairAndStay(page, 'RC2E vibration en erreur');

  await page.getByTestId('test-haptics').click();
  await expect(page.getByTestId('haptic-result')).toHaveAttribute('data-haptic-outcome', 'refused');

  expect(pageErrors, 'no uncontrolled exception escapes the diagnostic').toEqual([]);
  // And the screen still does its actual job.
  await page.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await page.waitForURL('**/counter');
});

test('le test de vibration ne réappaire pas, ne compte pas et ne navigue pas', async ({ page }) => {
  // The whole reason it is safe to put a button on the pairing screen: it is
  // a read of the browser's capability, not an action on the event.
  const pairRequests: string[] = [];
  const actionRequests: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url()).pathname;
    if (url === '/api/v1/device/pair') pairRequests.push(req.method());
    if (url.startsWith('/api/v1/device/actions')) actionRequests.push(req.method());
  });

  await stubVibration(page, 'accept');
  await pairAndStay(page, 'RC2E vibration sans effet de bord');

  expect(pairRequests, 'one pairing so far').toHaveLength(1);

  // Pressed repeatedly, the way someone checking a phone actually does.
  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('test-haptics').click();
  }
  await expect(page.getByTestId('haptic-result')).toBeVisible();

  expect(await vibrateCalls(page)).toHaveLength(3);
  // The QR token is single-use: a second /device/pair would burn an invite
  // and retire the identity this phone has just been given.
  expect(pairRequests, 'the token is never re-consumed').toHaveLength(1);
  expect(actionRequests, 'no movement is created or sent').toEqual([]);
  expect(await readOutbox(page), 'the outbox is untouched').toEqual([]);
  expect(new URL(page.url()).pathname, 'the operator stays on the pairing screen').toBe('/pair');

  // Still the completion step, still able to finish.
  await expect(page.getByText('Appairage réussi')).toBeVisible();
  await page.getByRole('button', { name: 'Continuer sans renommer' }).click();
  await page.waitForURL('**/counter');
});
