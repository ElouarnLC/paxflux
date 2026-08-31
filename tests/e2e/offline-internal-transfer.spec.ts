import { test, expect } from '@playwright/test';
import {
  getAdminSession,
  createDraftEventWithMainCheckpoint,
  addInternalTransferCheckpoint,
  startEvent,
  createDeviceInviteToken,
} from './helpers.js';

test('un transfert interne hors-ligne ne doit pas modifier la jauge globale projetée', async ({ page, context }) => {
  const session = await getAdminSession();
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: 'Repro Offline Internal Transfer',
    capacity: 200,
  });
  const { internalCheckpointId } = await addInternalTransferCheckpoint(session, topo, {
    zoneName: 'VIP',
    capacity: 50,
  });
  await startEvent(session, topo.eventId);
  const token = await createDeviceInviteToken(session, topo.eventId, internalCheckpointId);

  await page.goto(`/pair#${token}`);
  await page.waitForURL('**/counter');

  const occupancyValue = page.getByTestId('global-occupancy');
  await expect(occupancyValue).toHaveText('0');

  await context.setOffline(true);

  // This checkpoint connects two internal leaves (Site <-> VIP), not the
  // external boundary: a single tap must leave the *global* occupancy
  // projection unchanged (one leaf's count moves into another leaf's).
  await page.getByRole('button', { name: /→ VIP/ }).click();
  await page.waitForTimeout(300);

  // Today CounterView hardcodes `isSpaceBLeaf = true` and treats every
  // count as an entry from outside, so the optimistic projection wrongly
  // increments the global gauge even for a purely internal transfer.
  await expect(occupancyValue).toHaveText('0');
});
