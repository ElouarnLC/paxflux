import { test, expect, Page } from '@playwright/test';
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  AdminSession,
  adminApi,
  beginClosingEvent,
  completeDevicePairing,
  createDeviceInviteToken,
  createDraftEventWithMainCheckpoint,
  getAdminSession,
  getEventDevices,
  startEvent,
} from './helpers.js';

/**
 * Guards for the Phase 8 design system.
 *
 * The point of replacing `window.confirm` and `window.prompt` was never the
 * styling — it was that a browser dialog cannot show that force-closing is
 * dangerous, cannot validate a reason before accepting it, and, on an
 * installed PWA, renders as an unbranded system sheet naming the origin.
 * These tests hold the behaviour that replaced them: a real dialog in the
 * DOM, a cancel that sends nothing, a reason that is checked while it is
 * typed, and focus that comes back where it started.
 */

let session: AdminSession;

test.beforeAll(async () => {
  session = await getAdminSession();
});

async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

/**
 * Records every native dialog the page tries to open.
 *
 * Playwright dismisses `confirm`/`prompt` automatically, so a leftover
 * browser dialog would not fail a test by itself — it would silently
 * cancel the action and look like a passing no-op. This makes it visible.
 */
function watchNativeDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on('dialog', async (dialog) => {
    seen.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });
  return seen;
}

/** Counts the transition requests actually sent to the server. */
function watchTransitions(page: Page, eventId: string): string[] {
  const sent: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (req.method() !== 'POST') return;
    if (!url.pathname.startsWith(`/api/v1/events/${eventId}/`)) return;
    sent.push(url.pathname.split('/').pop()!);
  });
  return sent;
}

test('une transition de cycle de vie ouvre une vraie boîte de dialogue DOM', async ({ page }) => {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `DS dialog ${Date.now()}`,
    capacity: 100,
  });

  const nativeDialogs = watchNativeDialogs(page);
  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);

  await page.getByRole('button', { name: "Démarrer l'événement" }).click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: "Démarrer l'événement ?" })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Annuler' })).toBeVisible();

  expect(
    nativeDialogs,
    `a browser dialog was opened instead of (or as well as) the in-page one: ${nativeDialogs.join(' | ')}`
  ).toEqual([]);
});

test('annuler une confirmation n’envoie aucune transition', async ({ page }) => {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `DS cancel ${Date.now()}`,
    capacity: 100,
  });

  await loginAsAdmin(page);
  const sent = watchTransitions(page, topo.eventId);
  await page.goto(`/admin?event=${topo.eventId}`);

  await page.getByRole('button', { name: "Démarrer l'événement" }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByRole('alertdialog')).toBeHidden();

  // The event is still a draft, and nothing was even attempted: cancelling
  // must not reach the network at all.
  const after = await adminApi<{ id: string; status: string }>(
    session,
    'GET',
    `/api/v1/events/${topo.eventId}`
  );
  expect(after.status).toBe('draft');
  expect(sent, `cancel sent ${sent.join(', ')}`).toEqual([]);
});

test('le focus revient au déclencheur après la fermeture du dialogue', async ({ page }) => {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `DS focus ${Date.now()}`,
    capacity: 100,
  });

  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);

  const trigger = page.getByRole('button', { name: "Démarrer l'événement" });
  await trigger.click();
  await expect(page.getByRole('alertdialog')).toBeVisible();

  // Escape, because that is the path an operator takes when they opened
  // the wrong thing — and the one most likely to strand focus on <body>.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toBeHidden();

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const active = document.activeElement;
          if (!active || active === document.body) return '(body)';
          return `${active.tagName.toLowerCase()}: ${(active.textContent || '').trim().slice(0, 40)}`;
        }),
      {
        message:
          'focus did not return to the trigger: a keyboard user is left at the top of the document',
        timeout: 5_000,
      }
    )
    .toContain('Démarrer');
});

test('la fermeture forcée exige un motif, et l’envoie tel quel', async ({ page }) => {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `DS force ${Date.now()}`,
    capacity: 100,
  });
  await startEvent(session, topo.eventId);
  await beginClosingEvent(session, topo.eventId);

  const nativeDialogs = watchNativeDialogs(page);
  await loginAsAdmin(page);

  let forceClosePayload: unknown = null;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/force-close')) {
      forceClosePayload = JSON.parse(req.postData() || 'null');
    }
  });

  await page.goto(`/admin?event=${topo.eventId}`);

  await page.getByRole('button', { name: /Fermeture forcée/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const confirm = dialog.getByRole('button', { name: /Confirmer la fermeture forcée/i });
  const reason = dialog.getByRole('textbox');

  // Empty, then too short: the same refusal the server would give, but
  // before a request is spent on it.
  await expect(confirm).toBeDisabled();
  await reason.fill('ab');
  await expect(confirm).toBeDisabled();

  await reason.fill('Appareil perdu porte 3');
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => {
      const ev = await adminApi<{ status: string }>(session, 'GET', `/api/v1/events/${topo.eventId}`);
      return ev.status;
    }, { timeout: 10_000 })
    .toBe('closed');

  expect(forceClosePayload).toEqual({ reason: 'Appareil perdu porte 3' });
  expect(nativeDialogs).toEqual([]);
});

test('la réouverture exige elle aussi un motif audité', async ({ page }) => {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `DS reopen ${Date.now()}`,
    capacity: 100,
  });
  await startEvent(session, topo.eventId);
  await beginClosingEvent(session, topo.eventId);
  await adminApi(session, 'POST', `/api/v1/events/${topo.eventId}/force-close`, {
    reason: 'Mise en place du scénario',
  });

  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);

  await page.getByRole('button', { name: "Réouvrir l'événement" }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const confirm = dialog.getByRole('button', { name: "Réouvrir l'événement" });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox').fill('Clôture anticipée par erreur');
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect
    .poll(async () => {
      const ev = await adminApi<{ status: string }>(session, 'GET', `/api/v1/events/${topo.eventId}`);
      return ev.status;
    }, { timeout: 10_000 })
    .toBe('live');
});

test('révoquer un appareil passe par une confirmation, pas par une boîte navigateur', async ({
  page,
  browser,
}) => {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `DS revoke ${Date.now()}`,
    capacity: 100,
  });
  await startEvent(session, topo.eventId);

  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await completeDevicePairing(phone, token);

  await expect.poll(async () => (await getEventDevices(session, topo.eventId)).length).toBe(1);

  const nativeDialogs = watchNativeDialogs(page);
  await loginAsAdmin(page);
  await page.goto(`/admin/events/${topo.eventId}/devices`);

  await page.getByRole('button', { name: 'Révoquer', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();

  // Cancelling leaves the device alone — the destructive path is opt-in.
  // The list only reports non-revoked sessions, so still being on it *is*
  // the assertion that nothing was revoked.
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialog).toBeHidden();
  expect(await getEventDevices(session, topo.eventId)).toHaveLength(1);

  await page.getByRole('button', { name: 'Révoquer', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: "Révoquer l'appareil" }).click();

  await expect
    .poll(async () => (await getEventDevices(session, topo.eventId)).length, { timeout: 10_000 })
    .toBe(0);

  expect(nativeDialogs).toEqual([]);
  await phoneContext.close();
});

test('les statuts critiques restent identifiables par le texte, pas seulement par la couleur', async ({
  page,
}) => {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `DS statuts ${Date.now()}`,
    capacity: 100,
  });

  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);

  // Draft, then live, then closing: each transition must change a *word*
  // on screen, not only a hue. Scoped to the status badge rather than the
  // page, because the event selector's <option> text names the status too
  // and would satisfy a page-wide search without anything being displayed.
  const status = page.getByTestId('event-status');
  await expect(status).toHaveText('Brouillon');

  await startEvent(session, topo.eventId);
  await page.reload();
  await expect(status).toHaveText('En direct');

  await beginClosingEvent(session, topo.eventId);
  await page.reload();
  await expect(status).toHaveText('Fermeture');
});

test('le focus dessine un seul indicateur, pas deux superposés', async ({ page }) => {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `DS focus ring ${Date.now()}`,
    capacity: 100,
  });

  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);

  // Two rules can draw a focus indicator: the global `:focus-visible`
  // outline in styles/index.css, which is the floor under everything not
  // yet migrated, and the ring a primitive draws for itself. A migrated
  // control must have exactly one — a primitive may only step out from
  // under the floor by replacing it, never by adding to it.
  //
  // Measured across a control from each family, because the failure is
  // per-primitive: one component forgetting `focus-visible:outline-none`
  // is enough to double up.
  // Focus is moved with Tab rather than `element.focus()`: `:focus-visible`
  // is a keyboard notion, and a programmatic focus does not raise it on a
  // button — a test built on `.focus()` would measure a state no operator
  // ever sees.
  const seen: Array<{ tag: string; text: string; hasOutline: boolean; hasRing: boolean }> = [];
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press('Tab');
    const indicator = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        text:
          (el.textContent || '').trim().slice(0, 30) || el.getAttribute('aria-label') || '(no label)',
        hasOutline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
        hasRing: style.boxShadow !== 'none' && style.boxShadow.trim().length > 0,
      };
    });
    if (indicator) seen.push(indicator);
  }

  expect(seen.length, 'Tab reached nothing focusable on this page').toBeGreaterThan(4);

  expect(
    seen.filter((i) => !i.hasOutline && !i.hasRing),
    'control(s) show no focus indicator at all:\n' +
      JSON.stringify(seen.filter((i) => !i.hasOutline && !i.hasRing), null, 2)
  ).toEqual([]);

  expect(
    seen.filter((i) => i.hasOutline && i.hasRing),
    'control(s) draw both the global outline and their own ring — two indicators stacked on one control:\n' +
      JSON.stringify(seen.filter((i) => i.hasOutline && i.hasRing), null, 2)
  ).toEqual([]);
});
