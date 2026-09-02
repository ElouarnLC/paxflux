import { describe, expect, it } from 'vitest';
import {
  CompactEventState,
  EventDetailResponse,
  EventDeviceSummary,
  EventModel,
} from '@paxflux/shared';
import {
  acceptSupervisionResponse,
  applyLiveState,
  mergeSupervisionRefresh,
  summariseSyncQuality,
} from './supervision.js';

/**
 * The dashboard's supervision rules (RC2-B).
 *
 * Two defects are pinned here. The card claimed "tous les appareils sont
 * connectés" for an event with no devices at all, and called a single
 * offline device "plusieurs appareils déconnectés". And the refresh that
 * makes device state converge without an F5 must not, in doing so, let a
 * slow HTTP response overwrite occupancy that SSE has already moved past.
 */

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_EVENT_ID = '22222222-2222-4222-8222-222222222222';
const SPACE_A = '33333333-3333-4333-8333-333333333333';
const SPACE_B = '44444444-4444-4444-8444-444444444444';

function device(overrides: Partial<EventDeviceSummary> = {}): EventDeviceSummary {
  return {
    id: 'device-1',
    checkpointId: 'checkpoint-1',
    checkpointName: 'Porte principale',
    label: 'Poste 1',
    isOnline: true,
    lastSeenAtMs: 1_000,
    lastPendingCount: 0,
    appVersion: '1.0.0',
    ...overrides,
  };
}

function eventModel(version: number, status: EventModel['status'] = 'live'): EventModel {
  return {
    id: EVENT_ID,
    name: 'Festival',
    slug: 'festival',
    timezone: 'Europe/Paris',
    capacity: 500,
    status,
    warningRatio1: 0.8,
    warningRatio2: 0.9,
    startsAtMs: null,
    endsAtMs: null,
    liveStartedAtMs: 1_000,
    closingStartedAtMs: null,
    closedAtMs: null,
    archivedAtMs: null,
    version,
    topologyLockedAtMs: 1_000,
    createdBy: 'admin',
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function detail(
  version: number,
  occupancy: number,
  overrides: Partial<EventDetailResponse> = {}
): EventDetailResponse {
  return {
    event: eventModel(version),
    spaces: [],
    checkpoints: [],
    occupancy: { global: occupancy, spaces: { [SPACE_B]: occupancy } },
    devices: [],
    syncQuality: 'reliable',
    ...overrides,
  };
}

function liveState(version: number, occupancy: number): CompactEventState {
  return {
    version,
    eventStatus: 'live',
    eventOccupancy: occupancy,
    eventCapacity: 500,
    spaces: [
      { id: SPACE_A, name: 'Extérieur', kind: 'external', occupancy: 0, capacity: null },
      { id: SPACE_B, name: 'Site', kind: 'leaf', occupancy, capacity: 500 },
    ],
    serverTimeMs: 1_000 + version,
    closingStartedAtMs: null,
  };
}

describe('summariseSyncQuality — what the card is allowed to claim', () => {
  it('does not claim every device is connected when there is no device at all', () => {
    // The server returns `reliable` here: nothing is offline and nothing is
    // pending, because there is nothing. The verdict stands; the sentence
    // about it must not invent a fleet.
    const summary = summariseSyncQuality('reliable', []);

    expect(summary.status).toBe('reliable');
    expect(summary.presence).toBe('Aucun appareil appairé');
    expect(summary.pending).toBeNull();
    expect(summary.detail).not.toMatch(/tous les appareils/i);
    expect(summary.detail).toMatch(/aucun appareil/i);
  });

  it('counts one offline device as one, not as "plusieurs"', () => {
    // One device, offline: the server's rule makes this `uncertain`
    // (offlineCount === devices.length), and the old copy read "Plusieurs
    // appareils déconnectés" for a fleet of exactly one.
    const summary = summariseSyncQuality('uncertain', [device({ isOnline: false })]);

    expect(summary.status).toBe('unreliable');
    expect(summary.presence).toBe('0 appareil en ligne sur 1');
    expect(summary.detail).not.toMatch(/plusieurs/i);
    expect(summary.detail).toMatch(/aucun appareil ne répond/i);
  });

  it('says "plusieurs" only when more than one device is actually offline', () => {
    const summary = summariseSyncQuality('uncertain', [
      device({ id: 'a', isOnline: true }),
      device({ id: 'b', isOnline: false }),
      device({ id: 'c', isOnline: false }),
    ]);

    expect(summary.presence).toBe('1 appareil en ligne sur 3');
    expect(summary.detail).toMatch(/plusieurs appareils/i);
  });

  it('reports a healthy fleet with its size and no pending actions', () => {
    const summary = summariseSyncQuality('reliable', [
      device({ id: 'a' }),
      device({ id: 'b' }),
    ]);

    expect(summary.presence).toBe('2 appareils en ligne sur 2');
    expect(summary.pending).toBe('Aucune action en attente');
  });

  it('surfaces the pending total when actions are outstanding', () => {
    const summary = summariseSyncQuality('degraded', [
      device({ id: 'a', lastPendingCount: 3 }),
      device({ id: 'b', lastPendingCount: 1 }),
    ]);

    expect(summary.status).toBe('degraded');
    expect(summary.presence).toBe('2 appareils en ligne sur 2');
    expect(summary.pending).toBe('4 actions en attente');
    expect(summary.detail).toMatch(/pas encore été confirmés/i);
  });

  it('passes the server verdict through rather than re-deriving one', () => {
    // Devices that look healthy, but the server said `degraded`. The card
    // reports what the server decided — the client does not hold a second
    // opinion about presence.
    const summary = summariseSyncQuality('degraded', [device({ id: 'a' })]);
    expect(summary.status).toBe('degraded');
  });
});

describe('mergeSupervisionRefresh — supervision must not drag counting backwards', () => {
  it('takes everything from a refresh that is at least as fresh', () => {
    const prev = detail(20, 14);
    const incoming = detail(21, 15, {
      devices: [device({ isOnline: false })],
      syncQuality: 'uncertain',
    });

    const merged = mergeSupervisionRefresh(prev, incoming);

    expect(merged.event.version).toBe(21);
    expect(merged.occupancy.global).toBe(15);
    expect(merged.syncQuality).toBe('uncertain');
    expect(merged.devices).toHaveLength(1);
  });

  it('keeps newer SSE occupancy and version when the refresh is older', () => {
    // The refresh was minted at v18 and arrived after an SSE frame carrying
    // v20. Fixing stale device state must not resurrect a stale gauge.
    const prev = detail(20, 14);
    const incoming = detail(18, 9, {
      devices: [device({ isOnline: false })],
      syncQuality: 'uncertain',
    });

    const merged = mergeSupervisionRefresh(prev, incoming);

    expect(merged.event.version, 'the newer version is kept').toBe(20);
    expect(merged.occupancy.global, 'the newer occupancy is kept').toBe(14);
    // ...and the supervision half of the same response is still adopted,
    // because SSE never carries it.
    expect(merged.syncQuality).toBe('uncertain');
    expect(merged.devices[0].isOnline).toBe(false);
  });

  it('lets an equal-version refresh carry a lifecycle transition', () => {
    // `live → closing` does not bump `version`, so a strict `>` would drop
    // the transition and leave the dashboard reading `live`.
    const prev = detail(20, 14);
    const incoming: EventDetailResponse = {
      ...detail(20, 14),
      event: eventModel(20, 'closing'),
    };

    expect(mergeSupervisionRefresh(prev, incoming).event.status).toBe('closing');
  });

  it('adopts a response for a different event wholesale', () => {
    // Version counters are per-event; comparing across them is meaningless.
    const prev = detail(90, 40);
    const incoming: EventDetailResponse = {
      ...detail(2, 3),
      event: { ...eventModel(2), id: OTHER_EVENT_ID },
    };

    const merged = mergeSupervisionRefresh(prev, incoming);
    expect(merged.event.id).toBe(OTHER_EVENT_ID);
    expect(merged.event.version).toBe(2);
    expect(merged.occupancy.global).toBe(3);
  });

  it('adopts the first response when nothing is held yet', () => {
    expect(mergeSupervisionRefresh(null, detail(5, 2)).event.version).toBe(5);
  });
});

describe('acceptSupervisionResponse — a refresh loop must not follow the wrong event', () => {
  it('drops a late response for the event the operator has left', () => {
    // The selector moved to another event while this request was in flight.
    const prev: EventDetailResponse = {
      ...detail(4, 2),
      event: { ...eventModel(4), id: OTHER_EVENT_ID },
    };
    const lateForOldEvent = detail(99, 77, { syncQuality: 'uncertain' });

    expect(acceptSupervisionResponse(prev, lateForOldEvent, OTHER_EVENT_ID)).toBeNull();
  });

  it('drops any response once no event is selected', () => {
    expect(acceptSupervisionResponse(null, detail(1, 0), null)).toBeNull();
  });

  it('accepts a response for the event currently on screen', () => {
    const merged = acceptSupervisionResponse(detail(20, 14), detail(21, 15), EVENT_ID);
    expect(merged?.event.version).toBe(21);
  });

  it('still refuses to roll counting back for the event on screen', () => {
    const merged = acceptSupervisionResponse(
      detail(20, 14),
      detail(18, 9, { syncQuality: 'uncertain' }),
      EVENT_ID
    );
    expect(merged?.occupancy.global).toBe(14);
    expect(merged?.syncQuality).toBe('uncertain');
  });
});

describe('applyLiveState — SSE frames are ordered too', () => {
  it('applies a newer frame', () => {
    const next = applyLiveState(detail(20, 14), liveState(21, 15));
    expect(next?.event.version).toBe(21);
    expect(next?.occupancy.global).toBe(15);
    expect(next?.occupancy.spaces[SPACE_B]).toBe(15);
  });

  it('ignores a frame older than the state already held', () => {
    const prev = detail(20, 14);
    const next = applyLiveState(prev, liveState(18, 9));
    expect(next).toBe(prev);
  });

  it('does nothing before the first snapshot has arrived', () => {
    expect(applyLiveState(null, liveState(3, 1))).toBeNull();
  });
});
