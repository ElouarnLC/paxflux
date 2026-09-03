import { test, expect, Page } from '@playwright/test';
import {
  AdminSession,
  addInternalTransferCheckpoint,
  adjustSpaceOccupancy,
  completeDevicePairing,
  createDeviceInviteToken,
  createDraftEventWithMainCheckpoint,
  DraftEventTopology,
  getAdminSession,
  getEventState,
  startEvent,
} from './helpers.js';
import { displayedOccupancy, readOutbox } from './offline-helpers.js';

/**
 * RC2-E — ADR-004 on screen: an incoherent occupancy is reported, never
 * corrected.
 *
 * The five scenarios below are the ones a clamp would silently pass. Each
 * discriminates *projected* truth from *authoritative* truth, because the
 * cheap wrong fix — showing `Math.max(0, occupancy)` — looks identical to
 * the right one on every well-behaved event.
 *
 * The anomalies here are produced by real movements through the real API
 * rather than seeded into IndexedDB: half the invariant is that the server
 * accepts the movement in the first place, and a seeded state would assert
 * nothing about that.
 */

let session: AdminSession;

test.beforeAll(async () => {
  session = await getAdminSession();
});

async function liveEvent(name: string, capacity: number): Promise<DraftEventTopology> {
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `${name} · ${test.info().project.name}`,
    capacity,
  });
  await startEvent(session, topo.eventId);
  return topo;
}

async function pairOn(page: Page, eventId: string, checkpointId: string): Promise<void> {
  await completeDevicePairing(page, await createDeviceInviteToken(session, eventId, checkpointId));
}

/**
 * The server's own occupancy for this event.
 *
 * Read through the staff state route rather than the device one, so the
 * assertion is about what PaxFlux recorded and not about what this handset
 * was told.
 */
async function serverOccupancy(eventId: string): Promise<number> {
  return (await getEventState(session, eventId)).occupancy.global;
}

/** Waits for every queued action to have left the outbox. */
async function outboxDrained(page: Page): Promise<void> {
  await expect.poll(async () => (await readOutbox(page)).length, { timeout: 15_000 }).toBe(0);
}

const anomaly = (page: Page) => page.getByTestId('occupancy-anomaly');
const disclosure = (page: Page) => page.getByTestId('occupancy-pending-disclosure');

test('1 · une occupation serveur négative est affichée telle quelle', async ({ page }) => {
  // An exit counted before any entry. It happens: a door opened early, or a
  // handset that was offline through the first arrivals.
  const topo = await liveEvent('RC2E négatif autoritatif', 200);
  await pairOn(page, topo.eventId, topo.mainCheckpointId);

  await page.getByTestId('count-b-to-a').click();
  await outboxDrained(page);

  // The server recorded it — ADR-004 is a server invariant before it is a
  // display one, and a display test alone would not notice a movement the
  // API had refused.
  await expect.poll(() => serverOccupancy(topo.eventId), { timeout: 15_000 }).toBe(-1);

  await expect.poll(() => displayedOccupancy(page), { timeout: 15_000 }).toBe(-1);
  expect(await displayedOccupancy(page), 'never clamped to zero').not.toBe(0);

  // Reported, and reported as the server's own.
  await expect(anomaly(page)).toBeVisible();
  await expect(anomaly(page)).toHaveAttribute('data-anomaly-scope', 'authoritative');
  await expect(anomaly(page)).toHaveAttribute('data-anomaly-kind', 'negative');
  await expect(anomaly(page)).toContainText('Occupation négative');
  // Not colour alone: the reason is written out.
  await expect(anomaly(page)).toContainText('conserve les comptages tels quels');

  // Acknowledged, so there is nothing pending to disclose.
  await expect(disclosure(page)).toHaveCount(0);
});

test('2 · une projection négative est dite projetée, pas confirmée', async ({ page, context }) => {
  const topo = await liveEvent('RC2E négatif projeté', 200);
  await pairOn(page, topo.eventId, topo.mainCheckpointId);
  await expect.poll(() => displayedOccupancy(page)).toBe(0);

  await context.setOffline(true);
  try {
    await page.getByTestId('count-b-to-a').click();

    // The gauge follows the tap — optimistic counting is deliberate and
    // RC2-E does not remove it.
    await expect.poll(() => displayedOccupancy(page)).toBe(-1);

    // And the screen says which part of that is the server's.
    await expect(disclosure(page)).toContainText('Serveur : 0');
    await expect(disclosure(page)).toContainText('−1 en attente sur cet appareil');

    await expect(anomaly(page)).toHaveAttribute('data-anomaly-scope', 'projected');
    await expect(anomaly(page)).toContainText('Occupation projetée négative');
    await expect(anomaly(page)).toContainText('en attente de confirmation du serveur');
    // The lie this scenario exists to prevent: claiming the server holds a
    // value it has never seen.
    await expect(anomaly(page)).not.toContainText('conserve les comptages tels quels');

    // The server really is still at zero.
    expect(await serverOccupancy(topo.eventId)).toBe(0);
  } finally {
    await context.setOffline(false);
  }
});

test('3 · une occupation au-dessus de la capacité n’est pas ramenée à la capacité', async ({ page }) => {
  // Capacity 1 so two entries are enough; the arithmetic is the same at 1500.
  const topo = await liveEvent('RC2E dépassement', 1);
  await pairOn(page, topo.eventId, topo.mainCheckpointId);

  await page.getByTestId('count-a-to-b').click();
  await page.getByTestId('count-a-to-b').click();
  await outboxDrained(page);

  // The second movement was accepted, not refused for overflowing.
  await expect.poll(() => serverOccupancy(topo.eventId), { timeout: 15_000 }).toBe(2);

  await expect.poll(() => displayedOccupancy(page), { timeout: 15_000 }).toBe(2);
  expect(await displayedOccupancy(page), 'never clamped to capacity').not.toBe(1);

  await expect(anomaly(page)).toHaveAttribute('data-anomaly-kind', 'over-capacity');
  await expect(anomaly(page)).toHaveAttribute('data-anomaly-scope', 'authoritative');
  // Says it is an anomaly in words, and names both numbers — the existing
  // capacity badge only changes colour.
  await expect(anomaly(page)).toContainText('Capacité dépassée (2 / 1)');
});

test('4 · un acquittement converge sans double saut', async ({ page, context }) => {
  const topo = await liveEvent('RC2E convergence', 200);
  await pairOn(page, topo.eventId, topo.mainCheckpointId);
  await expect.poll(() => displayedOccupancy(page)).toBe(0);

  await context.setOffline(true);
  await page.getByTestId('count-a-to-b').click();
  await expect.poll(() => displayedOccupancy(page)).toBe(1);
  await expect(disclosure(page)).toContainText('Serveur : 0');
  await expect(disclosure(page)).toContainText('+1 en attente sur cet appareil');

  // Every value the gauge renders from here on, recorded as it happens. A
  // transient `2` — the acknowledged movement briefly projected on top of
  // the server's own total — is invisible to a before/after assertion and
  // is exactly the defect this scenario is for.
  await page.evaluate(() => {
    const node = document.querySelector('[data-testid="global-occupancy"]');
    if (!node) throw new Error('gauge not on screen');
    const seen: string[] = [(node.textContent ?? '').trim()];
    (window as unknown as { __gaugeValues: string[] }).__gaugeValues = seen;
    new MutationObserver(() => seen.push((node.textContent ?? '').trim())).observe(node, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  });

  await context.setOffline(false);
  await outboxDrained(page);

  // The explanation goes away because there is nothing left to explain.
  await expect(disclosure(page)).toHaveCount(0);
  expect(await displayedOccupancy(page), 'the number the operator was looking at did not move').toBe(1);
  expect(await serverOccupancy(topo.eventId)).toBe(1);

  const seen = await page.evaluate(() => (window as unknown as { __gaugeValues: string[] }).__gaugeValues);
  expect(new Set(seen), 'the gauge only ever showed 1 while the server caught up').toEqual(new Set(['1']));
});

test('5 · un transfert interne ne bouge pas la jauge globale et reste visible', async ({ page, context }) => {
  // The topology is locked the moment the event goes live, so the second
  // zone and its checkpoint are added while it is still a draft.
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `RC2E transfert interne · ${test.info().project.name}`,
    capacity: 200,
  });
  const { zoneSpaceId, internalCheckpointId } = await addInternalTransferCheckpoint(session, topo, {
    zoneName: 'VIP',
    capacity: 50,
  });
  await startEvent(session, topo.eventId);
  // Someone has to be inside before they can be moved: a supervised
  // adjustment puts four people on the site without going through a door.
  await adjustSpaceOccupancy(session, topo.eventId, topo.siteSpaceId, 4, 'Mise en place RC2-E');

  await pairOn(page, topo.eventId, internalCheckpointId);
  await expect.poll(() => displayedOccupancy(page), { timeout: 15_000 }).toBe(4);

  await context.setOffline(true);
  try {
    await page.getByTestId('count-a-to-b').click();

    // The global gauge does not move, and must not: nobody crossed the
    // boundary. This is the case a naive "+1 en attente" line would get
    // wrong in both directions.
    await expect.poll(() => displayedOccupancy(page)).toBe(4);

    // The zones did move, and say so — once, in one sentence, with no
    // figure that could be mistaken for a change to the gauge.
    await expect(disclosure(page)).toHaveAttribute('data-pending-scope', 'zones-only');
    await expect(disclosure(page)).toContainText('Serveur : 4');
    await expect(disclosure(page)).toContainText('transferts en attente sur cet appareil');
    await expect(disclosure(page)).not.toContainText('+0');

    // Per-zone projection: Site 4 → 3, VIP 0 → 1, each badge marked as
    // carrying something unacknowledged.
    await expect(page.getByTestId('space-a-occupancy')).toHaveAttribute('data-occupancy', '3');
    await expect(page.getByTestId('space-a-occupancy')).toHaveAttribute('data-pending', 'true');
    await expect(page.getByTestId('space-b-occupancy')).toHaveAttribute('data-occupancy', '1');
    await expect(page.getByTestId('space-b-occupancy')).toHaveAttribute('data-pending', 'true');
    // The marker is not colour alone: a screen reader is told the same thing.
    await expect(page.getByTestId('space-a-occupancy')).toContainText('en attente sur cet appareil');

    // And the action is still evident where pending work has always been
    // counted, rather than being restated a third time.
    await expect(page.getByText('HORS LIGNE (1)')).toBeVisible();

    // Nothing incoherent happened, so nothing is reported.
    await expect(anomaly(page)).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }

  // It converges on the server with the global gauge still untouched.
  await outboxDrained(page);
  const { occupancy } = await getEventState(session, topo.eventId);
  expect(occupancy.global, 'an internal transfer is a global delta of zero').toBe(4);
  expect(occupancy.spaces[topo.siteSpaceId]).toBe(3);
  expect(occupancy.spaces[zoneSpaceId]).toBe(1);
});
