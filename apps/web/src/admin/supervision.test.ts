import { describe, expect, it } from 'vitest';
import {
  CompactEventState,
  EventDetailResponse,
  EventDeviceSummary,
  EventModel,
} from '@paxflux/shared';
import {
  DashboardView,
  acceptSupervisionResponse,
  applyLiveState,
  mergeSupervisionRefresh,
  summariseSyncQuality,
  viewFromDetail,
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

function eventModel(
  version: number,
  status: EventModel['status'] = 'live',
  updatedAtMs = 1_000
): EventModel {
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
    updatedAtMs,
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

function liveState(
  version: number,
  occupancy: number,
  lifecycle: { status?: EventModel['status']; atMs?: number } = {}
): CompactEventState {
  return {
    version,
    eventStatus: lifecycle.status ?? 'live',
    eventOccupancy: occupancy,
    eventCapacity: 500,
    spaces: [
      { id: SPACE_A, name: 'Extérieur', kind: 'external', occupancy: 0, capacity: null },
      { id: SPACE_B, name: 'Site', kind: 'leaf', occupancy, capacity: 500 },
    ],
    // The moment the server minted this frame, and therefore a moment at
    // which the status it carries was true.
    serverTimeMs: lifecycle.atMs ?? 1_000 + version,
    closingStartedAtMs: null,
  };
}

/** A detail response with explicit lifecycle fields. */
function detailWith(
  version: number,
  occupancy: number,
  lifecycle: { status?: EventModel['status']; updatedAtMs?: number } = {}
): EventDetailResponse {
  return {
    ...detail(version, occupancy),
    event: eventModel(version, lifecycle.status ?? 'live', lifecycle.updatedAtMs ?? 1_000),
  };
}

/** What the dashboard holds: a response plus the epoch of its status. */
function view(detailResponse: EventDetailResponse, lifecycleAtMs?: number): DashboardView {
  const built = viewFromDetail(detailResponse);
  return lifecycleAtMs === undefined ? built : { ...built, lifecycleAtMs };
}

function viewDetail(
  version: number,
  occupancy: number,
  lifecycle: { status?: EventModel['status']; updatedAtMs?: number } = {}
): EventDetailResponse {
  return detailWith(version, occupancy, lifecycle);
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
    const prev = view(detail(20, 14));
    const incoming = detail(21, 15, {
      devices: [device({ isOnline: false })],
      syncQuality: 'uncertain',
    });

    const merged = mergeSupervisionRefresh(prev, incoming);

    expect(merged.detail.event.version).toBe(21);
    expect(merged.detail.occupancy.global).toBe(15);
    expect(merged.detail.syncQuality).toBe('uncertain');
    expect(merged.detail.devices).toHaveLength(1);
  });

  it('keeps newer SSE occupancy and version when the refresh is older', () => {
    // The refresh was minted at v18 and arrived after an SSE frame carrying
    // v20. Fixing stale device state must not resurrect a stale gauge.
    const prev = view(detail(20, 14));
    const incoming = detail(18, 9, {
      devices: [device({ isOnline: false })],
      syncQuality: 'uncertain',
    });

    const merged = mergeSupervisionRefresh(prev, incoming);

    expect(merged.detail.event.version, 'the newer version is kept').toBe(20);
    expect(merged.detail.occupancy.global, 'the newer occupancy is kept').toBe(14);
    // ...and the supervision half of the same response is still adopted,
    // because SSE never carries it.
    expect(merged.detail.syncQuality).toBe('uncertain');
    expect(merged.detail.devices[0].isOnline).toBe(false);
  });

  it('lets an equal-version refresh carry a lifecycle transition', () => {
    // `live → closing` does not bump `version`, so a strict `>` would drop
    // the transition and leave the dashboard reading `live`.
    const prev = view(detail(20, 14), 1_000);
    const incoming = detailWith(20, 14, { status: 'closing', updatedAtMs: 2_000 });

    expect(mergeSupervisionRefresh(prev, incoming).detail.event.status).toBe('closing');
  });

  it('adopts a response for a different event wholesale', () => {
    // Version counters are per-event; comparing across them is meaningless.
    const prev = view(detail(90, 40));
    const incoming: EventDetailResponse = {
      ...detail(2, 3),
      event: { ...eventModel(2), id: OTHER_EVENT_ID },
    };

    const merged = mergeSupervisionRefresh(prev, incoming);
    expect(merged.detail.event.id).toBe(OTHER_EVENT_ID);
    expect(merged.detail.event.version).toBe(2);
    expect(merged.detail.occupancy.global).toBe(3);
  });

  it('adopts the first response when nothing is held yet', () => {
    expect(mergeSupervisionRefresh(null, detail(5, 2)).detail.event.version).toBe(5);
  });
});

describe('lifecycle ordering — a lifecycle change does not bump event.version', () => {
  it('does not let an older same-version HTTP response undo a closing seen over SSE', () => {
    // The exact interleaving from the RC2-B review:
    //
    //   held:      v20 / live
    //   GET /state starts and reads the row: v20 / live, updatedAtMs 1_000
    //   server transitions to closing at 2_000 — version stays 20
    //   SSE frame minted at 2_050 carries closing, and is applied
    //   the older HTTP response completes last
    //
    // Version alone cannot separate these two: both say 20. The HTTP
    // response describes the event as it stood *before* the transition.
    const held = view(detail(20, 14), 1_000);
    const afterSse = applyLiveState(held, liveState(20, 14, { status: 'closing', atMs: 2_050 }));
    expect(afterSse?.detail.event.status).toBe('closing');

    const staleHttp = viewDetail(20, 14, { status: 'live', updatedAtMs: 1_000 });
    const merged = mergeSupervisionRefresh(afterSse, staleHttp);

    expect(merged.detail.event.status, 'closing must survive the late response').toBe('closing');
  });

  it('still converges live → closing from HTTP when the SSE transition was missed', () => {
    // The inverse, which a strict `>` on version would break: nothing was
    // pushed (dropped frame, stream reconnecting), so the poll is the only
    // way this dashboard will ever learn the event is closing — and it
    // carries the same version 20.
    const held = view(detail(20, 14), 1_000);
    const freshHttp = viewDetail(20, 14, { status: 'closing', updatedAtMs: 2_000 });

    const merged = mergeSupervisionRefresh(held, freshHttp);

    expect(merged.detail.event.status, 'the poll must be able to carry the transition').toBe('closing');
    expect(merged.lifecycleAtMs).toBe(2_000);
  });

  it('handles reopen, where the status ordering runs backwards', () => {
    // `closed → live` means no monotonic ordering of status values can be
    // assumed. Only the epoch decides.
    const closed = view(detailWith(20, 14, { status: 'closed', updatedAtMs: 3_000 }), 3_000);
    const reopened = viewDetail(20, 14, { status: 'live', updatedAtMs: 4_000 });

    expect(mergeSupervisionRefresh(closed, reopened).detail.event.status).toBe('live');

    // ...and a response minted before the reopen cannot close it again.
    const staleClosed = viewDetail(20, 14, { status: 'closed', updatedAtMs: 3_000 });
    const afterReopen = mergeSupervisionRefresh(closed, reopened);
    expect(mergeSupervisionRefresh(afterReopen, staleClosed).detail.event.status).toBe('live');
  });

  it('does not let an older SSE frame undo a newer lifecycle either', () => {
    const held = view(detailWith(20, 14, { status: 'closing', updatedAtMs: 2_000 }), 2_000);
    const olderFrame = applyLiveState(held, liveState(20, 14, { status: 'live', atMs: 1_500 }));

    expect(olderFrame?.detail.event.status).toBe('closing');
  });

  it('keeps counting and lifecycle on their own clocks', () => {
    // A refresh that is older for counting can still be newer for
    // lifecycle, and vice versa: they are ordered by different signals.
    const held = view(detail(20, 14), 1_000);
    const newerLifecycleOlderCounting = viewDetail(18, 9, { status: 'closing', updatedAtMs: 2_000 });

    const merged = mergeSupervisionRefresh(held, newerLifecycleOlderCounting);

    expect(merged.detail.event.status, 'lifecycle advances').toBe('closing');
    expect(merged.detail.event.version, 'counting does not roll back').toBe(20);
    expect(merged.detail.occupancy.global).toBe(14);
  });
});

describe('acceptSupervisionResponse — a refresh loop must not follow the wrong event', () => {
  it('drops a late response for the event the operator has left', () => {
    // The selector moved to another event while this request was in flight.
    const prev = view({
      ...detail(4, 2),
      event: { ...eventModel(4), id: OTHER_EVENT_ID },
    });
    const lateForOldEvent = detail(99, 77, { syncQuality: 'uncertain' });

    expect(acceptSupervisionResponse(prev, lateForOldEvent, OTHER_EVENT_ID)).toBeNull();
  });

  it('drops any response once no event is selected', () => {
    expect(acceptSupervisionResponse(null, detail(1, 0), null)).toBeNull();
  });

  it('accepts a response for the event currently on screen', () => {
    const merged = acceptSupervisionResponse(view(detail(20, 14)), detail(21, 15), EVENT_ID);
    expect(merged?.detail.event.version).toBe(21);
  });

  it('still refuses to roll counting back for the event on screen', () => {
    const merged = acceptSupervisionResponse(
      view(detail(20, 14)),
      detail(18, 9, { syncQuality: 'uncertain' }),
      EVENT_ID
    );
    expect(merged?.detail.occupancy.global).toBe(14);
    expect(merged?.detail.syncQuality).toBe('uncertain');
  });
});

describe('applyLiveState — SSE frames are ordered too', () => {
  it('applies a newer frame', () => {
    const next = applyLiveState(view(detail(20, 14)), liveState(21, 15));
    expect(next?.detail.event.version).toBe(21);
    expect(next?.detail.occupancy.global).toBe(15);
    expect(next?.detail.occupancy.spaces[SPACE_B]).toBe(15);
  });

  it('ignores a frame older than the state already held', () => {
    const prev = view(detail(20, 14));
    const next = applyLiveState(prev, liveState(18, 9));
    expect(next?.detail.occupancy.global).toBe(14);
    expect(next?.detail.event.version).toBe(20);
  });

  it('does nothing before the first snapshot has arrived', () => {
    expect(applyLiveState(null, liveState(3, 1))).toBeNull();
  });
});
