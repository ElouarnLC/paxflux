import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompactEventState, DeviceBootstrapResponse, OutboxActionOwner } from '@paxflux/shared';
import { localDb } from './db.js';
import {
  beginPairingHandoff,
  currentOwner,
  loadSnapshot,
  persistAuthoritativeState,
  persistBootstrap,
  persistLifecycleStatus,
  resolveEffectiveStatus,
} from './snapshot.js';
import { enqueueCountAction } from './outbox.js';

/**
 * The authoritative-state boundary a new pairing creates (RC2-A).
 *
 * A server restore deliberately moves the event version *backwards*: the
 * database is rolled back, but the browser's IndexedDB is not. These tests
 * run against a real in-memory IndexedDB because what is at stake is exactly
 * which writes commit, and against which prior row.
 */

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const CHECKPOINT_ID = '33333333-3333-4333-8333-333333333333';
const SPACE_A = '44444444-4444-4444-8444-444444444444';
const SPACE_B = '55555555-5555-4555-8555-555555555555';
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

function state(version: number, occupancy: number, serverTimeMs: number): CompactEventState {
  return {
    version,
    eventStatus: 'live',
    eventOccupancy: occupancy,
    eventCapacity: 500,
    spaces: [
      { id: SPACE_A, name: 'Extérieur', kind: 'external', occupancy: 0, capacity: null },
      { id: SPACE_B, name: 'Site', kind: 'leaf', occupancy, capacity: 500 },
    ],
    serverTimeMs,
    closingStartedAtMs: null,
  };
}

function bootstrap(sessionId: string, eventState: CompactEventState): DeviceBootstrapResponse {
  return {
    event: { id: EVENT_ID, name: 'Festival', status: eventState.eventStatus, capacity: 500 },
    checkpoint: {
      id: CHECKPOINT_ID,
      name: 'Porte A',
      spaceAId: SPACE_A,
      spaceBId: SPACE_B,
      spaceAName: 'Extérieur',
      spaceBName: 'Site',
      labelAToB: 'ENTRÉE +1',
      labelBToA: 'SORTIE −1',
      allowAToB: true,
      allowBToA: true,
    },
    deviceSession: { id: sessionId, label: 'Téléphone' },
    state: eventState,
  };
}

const OWNER_S1: OutboxActionOwner = {
  deviceSessionId: S1,
  eventId: EVENT_ID,
  checkpointId: CHECKPOINT_ID,
};

/** The field situation: paired as S1, local state has run ahead to v20 / 14. */
async function establishPreRestoreState(): Promise<void> {
  await persistBootstrap(bootstrap(S1, state(20, 14, 20_000)));
}

beforeEach(async () => {
  await localDb.open();
  await localDb.device_config.clear();
  await localDb.event_state.clear();
  await localDb.outbox_actions.clear();
  await localDb.confirmed_actions.clear();
  await localDb.meta.clear();
});

afterEach(async () => {
  await localDb.device_config.clear();
  await localDb.event_state.clear();
  await localDb.outbox_actions.clear();
  await localDb.confirmed_actions.clear();
  await localDb.meta.clear();
});

describe('a new pairing establishes a new authoritative baseline', () => {
  it('adopts a restored bootstrap whose version is lower than the state held locally', async () => {
    // Field reproduction: server rolled back from v20/14 to v13/10 by a
    // database restore, the browser still holds v20/14, and the SAME browser
    // pairs again with a fresh QR code.
    await establishPreRestoreState();
    expect((await loadSnapshot()).state?.eventOccupancy).toBe(14);

    await beginPairingHandoff(S2);
    const accepted = await persistBootstrap(bootstrap(S2, state(13, 10, 13_000)));

    expect(accepted, 'the authenticated bootstrap for the new session must be accepted').toBe(true);

    const snapshot = await loadSnapshot();
    expect(snapshot.bootstrap?.deviceSession.id, 'device_config is the new session').toBe(S2);
    expect(snapshot.state?.version, 'the restored version becomes the baseline').toBe(13);
    expect(
      snapshot.state?.eventOccupancy,
      'the counter must show the restored occupancy, not the pre-restore one'
    ).toBe(10);
    expect(await currentOwner()).toMatchObject({ deviceSessionId: S2 });
  });

  it('accepts ordinary server progress after the reset baseline', async () => {
    await establishPreRestoreState();
    await beginPairingHandoff(S2);
    await persistBootstrap(bootstrap(S2, state(13, 10, 13_000)));

    // The event moves on from the restored point, by any route.
    const stored = await persistAuthoritativeState(EVENT_ID, state(14, 11, 14_000), 'sse');

    expect(stored).toBe(true);
    const snapshot = await loadSnapshot();
    expect(snapshot.state?.version).toBe(14);
    expect(snapshot.state?.eventOccupancy).toBe(11);
  });

  it('drops the lifecycle marker of the state it replaces', async () => {
    // A marker recorded before the restore describes a transition that, on
    // the restored database, has not happened. Carrying it across the new
    // baseline would freeze a status the server no longer reports.
    await establishPreRestoreState();
    await persistLifecycleStatus(EVENT_ID, 'closing', 20_500);
    expect((await loadSnapshot()).lifecycle).toMatchObject({ status: 'closing' });

    await beginPairingHandoff(S2);
    await persistBootstrap(bootstrap(S2, state(13, 10, 13_000)));

    const snapshot = await loadSnapshot();
    expect(snapshot.lifecycle, 'the pre-restore transition must not survive the new baseline').toBeNull();
    expect(resolveEffectiveStatus(snapshot.state!, snapshot.lifecycle)).toBe('live');
  });

  it('commits the configuration and the baseline together, or not at all', async () => {
    await establishPreRestoreState();
    await beginPairingHandoff(S2);
    await persistBootstrap(bootstrap(S2, state(13, 10, 13_000)));

    const config = await localDb.device_config.get('current');
    const stored = await localDb.event_state.get('current');

    // The two rows must describe the same pairing: a configuration naming S2
    // beside a baseline still holding the pre-restore state is the bug.
    expect(config?.bootstrap?.deviceSession.id).toBe(S2);
    expect(config?.pendingSessionId, 'the handoff is complete').toBeUndefined();
    expect(stored?.state.version).toBe(13);
  });
});

describe('the boundary is an identity change, not a licence for stale state', () => {
  it('still rejects an older bootstrap for the session already established', async () => {
    await establishPreRestoreState();
    await beginPairingHandoff(S2);
    await persistBootstrap(bootstrap(S2, state(20, 14, 20_000)));

    // S2 is established at v20. A late bootstrap for the *same* session,
    // minted earlier, must not roll the device backwards.
    const accepted = await persistBootstrap(bootstrap(S2, state(13, 10, 13_000)));

    expect(accepted, 'the configuration write itself is for the current identity').toBe(true);
    const snapshot = await loadSnapshot();
    expect(snapshot.state?.version, 'freshness ordering still governs a same-session refresh').toBe(20);
    expect(snapshot.state?.eventOccupancy).toBe(14);
  });

  it('never lets a late bootstrap for the retired session take charge again', async () => {
    await establishPreRestoreState();
    await beginPairingHandoff(S2);

    // An S1 bootstrap that was already in flight when the handoff began.
    const accepted = await persistBootstrap(bootstrap(S1, state(21, 15, 21_000)));

    expect(accepted, 'a bootstrap for the retired identity is refused').toBe(false);
    const config = await localDb.device_config.get('current');
    expect(config?.bootstrap, 'S1 must not be reinstated').toBeUndefined();
    expect(config?.pendingSessionId, 'the device is still waiting for S2').toBe(S2);
    expect(await currentOwner(), 'no identity may act until S2 is configured').toBeNull();

    const snapshot = await loadSnapshot();
    expect(snapshot.awaitingConfigurationFor).toBe(S2);
    expect(snapshot.bootstrap).toBeNull();
  });

  it('keeps the counter non-operational when the new pairing has no configuration yet', async () => {
    await establishPreRestoreState();
    await beginPairingHandoff(S2);

    const snapshot = await loadSnapshot();
    expect(snapshot.bootstrap, 'the retired configuration is gone immediately').toBeNull();
    expect(snapshot.awaitingConfigurationFor).toBe(S2);
    expect(await currentOwner()).toBeNull();
  });
});

describe('the old owner’s queued counts survive the handoff untouched', () => {
  it('neither deletes them, nor reassigns them, nor projects them as the new session', async () => {
    await establishPreRestoreState();
    await enqueueCountAction('a_to_b', OWNER_S1);
    await enqueueCountAction('a_to_b', OWNER_S1);

    const before = await localDb.outbox_actions.toArray();
    expect(before).toHaveLength(2);

    await beginPairingHandoff(S2);
    await persistBootstrap(bootstrap(S2, state(13, 10, 13_000)));

    const after = await localDb.outbox_actions.toArray();
    expect(after, 'real counting intent is never discarded to make the UI agree').toHaveLength(2);
    for (const row of after) {
      expect(row.owner?.deviceSessionId, 'ownership stays with the session that created it').toBe(S1);
    }

    // And the restored baseline is the bootstrap's, not the bootstrap's plus
    // the old owner's pending taps.
    const snapshot = await loadSnapshot();
    expect(snapshot.state?.eventOccupancy).toBe(10);
  });
});

describe('the baseline survives a reload', () => {
  it('reads back the restored state, not the pre-restore one', async () => {
    await establishPreRestoreState();
    await beginPairingHandoff(S2);
    await persistBootstrap(bootstrap(S2, state(13, 10, 13_000)));

    // A reload re-reads from IndexedDB with nothing held in memory.
    await localDb.close();
    await localDb.open();

    const snapshot = await loadSnapshot();
    expect(snapshot.bootstrap?.deviceSession.id).toBe(S2);
    expect(snapshot.state?.version).toBe(13);
    expect(snapshot.state?.eventOccupancy, 'the pre-restore value must not reappear').toBe(10);
  });
});
