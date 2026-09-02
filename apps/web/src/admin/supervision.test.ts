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
  applyLifecycleMessage,
  isLifecyclePushForEvent,
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
    // When the server *stamped* this frame — which the producer test shows
    // is not when its `eventStatus` was read: `getCompactEventState` reads
    // the event row, issues two more queries, and only then calls
    // `Date.now()`. A frame can therefore carry an old status under a newer
    // timestamp, which is why nothing here reads it for lifecycle.
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

/**
 * A fence for a request no push overtook: the generation read when it was
 * issued equals the one read when its response arrived.
 */
function openFence(generation = 0, requestSeq = 1) {
  return { generationAtStart: generation, generationAtEnd: generation, requestSeq };
}

/** A fence for a request a push overtook while it was in flight. */
function overtakenFence(generationAtStart: number, generationAtEnd: number, requestSeq = 1) {
  return { generationAtStart, generationAtEnd, requestSeq };
}

/** What the dashboard holds, wrapped for the tests. */
function view(detailResponse: EventDetailResponse): DashboardView {
  return viewFromDetail(detailResponse);
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

    const merged = mergeSupervisionRefresh(prev, incoming, openFence(0, 1));

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

    const merged = mergeSupervisionRefresh(prev, incoming, openFence(0, 1));

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
    const prev = view(detail(20, 14));
    const incoming = detailWith(20, 14, { status: 'closing' });

    expect(mergeSupervisionRefresh(prev, incoming, openFence(0, 1)).detail.event.status).toBe('closing');
  });

  it('adopts a response for a different event wholesale', () => {
    // Version counters are per-event; comparing across them is meaningless.
    const prev = view(detail(90, 40));
    const incoming: EventDetailResponse = {
      ...detail(2, 3),
      event: { ...eventModel(2), id: OTHER_EVENT_ID },
    };

    const merged = mergeSupervisionRefresh(prev, incoming, openFence(0, 1));
    expect(merged.detail.event.id).toBe(OTHER_EVENT_ID);
    expect(merged.detail.event.version).toBe(2);
    expect(merged.detail.occupancy.global).toBe(3);
  });

  it('adopts the first response when nothing is held yet', () => {
    expect(mergeSupervisionRefresh(null, detail(5, 2), openFence(0, 1)).detail.event.version).toBe(5);
  });
});

describe('lifecycle ordering — a generation fence, not a clock', () => {
  // A refresh carries the generation it observed when it *started*. If a
  // pushed transition landed while it was in flight, its lifecycle is stale
  // by construction, whatever its timestamps say.
  // A request no push crossed: the counter reads the same at both ends.
  const fence = (generation: number, requestSeq: number) => ({
    generationAtStart: generation,
    generationAtEnd: generation,
    requestSeq,
  });
  // A request a push crossed while it was in flight.
  const crossed = (start: number, end: number, requestSeq: number) => ({
    generationAtStart: start,
    generationAtEnd: end,
    requestSeq,
  });

  it('does not let an older HTTP response undo a closing seen over SSE', () => {
    //   held:      v20 / live, generation 0
    //   GET /state starts, observing generation 0
    //   server transitions to closing; the message applies, generation -> 1
    //   the older HTTP response, describing `live`, completes last
    const held = view(detail(20, 14));
    // The request was issued at generation 0; the push takes it to 1 before
    // the response lands, so its two ends disagree.
    const overtaken = crossed(0, 1, 1);

    const afterPush = applyLifecycleMessage(held, {
      eventId: EVENT_ID,
      status: 'closing',
      timestampMs: 2_000,
    });
    expect(afterPush?.detail.event.status).toBe('closing');

    const merged = mergeSupervisionRefresh(afterPush, detailWith(20, 14, { status: 'live' }), overtaken);
    expect(merged.detail.event.status, 'the fence rejects a response the push overtook').toBe('closing');
  });

  it('rejects the overtaken response even when its timestamp is equal or newer', () => {
    // Timestamps are not consulted at all now, so neither an equal nor an
    // inverted one can resurrect the old status.
    const held = view(detail(20, 14));
    const overtaken = crossed(0, 1, 1);
    const afterPush = applyLifecycleMessage(held, {
      eventId: EVENT_ID,
      status: 'closing',
      timestampMs: 2_000,
    });

    for (const updatedAtMs of [2_000, 9_999]) {
      const merged = mergeSupervisionRefresh(
        afterPush,
        detailWith(20, 14, { status: 'live', updatedAtMs }),
        overtaken
      );
      expect(merged.detail.event.status, `updatedAtMs ${updatedAtMs}`).toBe('closing');
    }
  });

  it('accepts a genuinely later transition even when the server clock stepped backwards', () => {
    //   held:    closing, learnt at 2000
    //   the clock steps back; the real next transition closing -> closed
    //   carries updatedAtMs 1900.
    // A clock-ordered rule refuses this forever, because nothing guarantees
    // a later mutation ever writes above 2000 once the event is closed.
    const closing = applyLifecycleMessage(
      view(detail(20, 14)),
      { eventId: EVENT_ID, status: 'closing', timestampMs: 2_000 }
    );

    const viaPush = applyLifecycleMessage(closing, { eventId: EVENT_ID, status: 'closed', timestampMs: 1_900 });
    expect(viaPush?.detail.event.status, 'a push is authoritative regardless of its clock').toBe('closed');

    // ...and the same is true if only the poll sees it.
    const viaHttp = mergeSupervisionRefresh(
      closing,
      detailWith(20, 14, { status: 'closed', updatedAtMs: 1_900 }),
      fence(0, 1)
    );
    expect(viaHttp.detail.event.status, 'the poll converges on a rolled-back clock too').toBe('closed');
  });

  it('converges from HTTP when the pushed transition was missed entirely', () => {
    // Nothing arrived — a dropped frame, or a stream that reconnected and
    // got only a `state` snapshot, which carries no lifecycle.
    const held = view(detail(20, 14));
    const merged = mergeSupervisionRefresh(
      held,
      detailWith(20, 14, { status: 'closing' }),
      fence(0, 1)
    );

    expect(merged.detail.event.status).toBe('closing');
    expect(merged.lifecycleRequestSeq).toBe(1);
  });

  it('same millisecond: a count and a transition sharing a timestamp still order correctly', () => {
    //   count at t=2000      -> live,    version 21, updatedAtMs 2000
    //   /state captures that response
    //   begin-closing at t=2000 -> closing, version 21, updatedAtMs 2000
    // An equal timestamp proves nothing about which came first, so the old
    // response must not be able to restore `live`.
    const held = view(detail(20, 14));
    const overtaken = crossed(0, 1, 1);

    const afterPush = applyLifecycleMessage(held, {
      eventId: EVENT_ID,
      status: 'closing',
      timestampMs: 2_000,
    });

    const staleCountResponse = {
      ...detailWith(21, 15, { status: 'live', updatedAtMs: 2_000 }),
    };
    const merged = mergeSupervisionRefresh(afterPush, staleCountResponse, overtaken);

    expect(merged.detail.event.status, 'lifecycle holds').toBe('closing');
    // ...while its counting, ordered by version, is still adopted.
    expect(merged.detail.event.version).toBe(21);
    expect(merged.detail.occupancy.global).toBe(15);
  });

  it('two concurrent refreshes cannot regress the lifecycle', () => {
    // `LifecycleControls`'s `onChanged` fires a refresh while a poll is
    // already in flight, so two HTTP responses can land out of order with no
    // push between them — the archive case, which emits no `event-status`.
    const held = view(detail(20, 14));
    const first = fence(0, 1);
    const second = fence(0, 2);

    // The later request completes first and carries the newer truth.
    const afterSecond = mergeSupervisionRefresh(
      held,
      detailWith(20, 14, { status: 'archived' }),
      second
    );
    expect(afterSecond.detail.event.status).toBe('archived');
    expect(afterSecond.lifecycleRequestSeq).toBe(2);

    // The earlier request completes afterwards, describing the older state.
    const afterFirst = mergeSupervisionRefresh(
      afterSecond,
      detailWith(20, 14, { status: 'closed' }),
      first
    );
    expect(afterFirst.detail.event.status, 'an earlier request cannot win').toBe('archived');
  });

  it('lets a later refresh converge after an earlier one was refused', () => {
    // The refusal above must not be terminal: the next poll has a higher
    // sequence and no push in flight, so convergence is genuinely bounded.
    const held = view(detail(20, 14));
    const afterSecond = mergeSupervisionRefresh(
      held,
      detailWith(20, 14, { status: 'closed' }),
      fence(0, 2)
    );
    const next = mergeSupervisionRefresh(
      afterSecond,
      detailWith(20, 14, { status: 'archived' }),
      fence(0, 3)
    );

    expect(next.detail.event.status).toBe('archived');
  });

  it('archive converges through the poll, since it broadcasts no event-status', () => {
    // `/events/:id/archive` writes the row, revokes the device sessions and
    // calls `closeAllForEvent` — the stream is torn down rather than told.
    const closed = applyLifecycleMessage(
      view(detail(20, 14)),
      { eventId: EVENT_ID, status: 'closed', timestampMs: 3_000 }
    );
    const merged = mergeSupervisionRefresh(
      closed,
      detailWith(20, 14, { status: 'archived', updatedAtMs: 3_500 }),
      fence(0, 1)
    );

    expect(merged.detail.event.status).toBe('archived');
  });

  it('handles reopen, where the status ordering runs backwards', () => {
    const closed = applyLifecycleMessage(
      view(detail(20, 14)),
      { eventId: EVENT_ID, status: 'closed', timestampMs: 3_000 }
    );

    const viaPush = applyLifecycleMessage(closed, { eventId: EVENT_ID, status: 'live', timestampMs: 4_000 });
    expect(viaPush?.detail.event.status).toBe('live');

    const viaHttp = mergeSupervisionRefresh(
      closed,
      detailWith(20, 14, { status: 'live', updatedAtMs: 4_000 }),
      fence(0, 1)
    );
    expect(viaHttp.detail.event.status).toBe('live');
  });

  it('ignores the lifecycle a state frame carries, whatever timestamp it bears', () => {
    const held = applyLifecycleMessage(
      view(detail(20, 14)),
      { eventId: EVENT_ID, status: 'closing', timestampMs: 2_000 }
    );
    const inverted = applyLiveState(held, liveState(20, 14, { status: 'live', atMs: 2_050 }));

    expect(inverted?.detail.event.status, 'a state frame may never set the status').toBe('closing');
    expect(inverted?.lifecycleRequestSeq, 'nor touch the fence').toBe(held?.lifecycleRequestSeq);
  });

  it('still applies the counting a state frame carries', () => {
    const held = applyLifecycleMessage(
      view(detail(20, 14)),
      { eventId: EVENT_ID, status: 'closing', timestampMs: 2_000 }
    );
    const next = applyLiveState(held, liveState(21, 15, { status: 'live', atMs: 2_050 }));

    expect(next?.detail.occupancy.global).toBe(15);
    expect(next?.detail.event.version).toBe(21);
    expect(next?.detail.event.status).toBe('closing');
  });

  it('ignores an event-status message about a different event', () => {
    const held = view(detail(20, 14));
    const next = applyLifecycleMessage(held, { eventId: OTHER_EVENT_ID, status: 'closed', timestampMs: 9_000 });

    expect(next?.detail.event.status).toBe('live');
    expect(next, 'a foreign message returns the held view untouched').toBe(held);
  });

  it('keeps counting and lifecycle on their own rules', () => {
    const held = view(detail(20, 14));
    const merged = mergeSupervisionRefresh(
      held,
      detailWith(18, 9, { status: 'closing' }),
      fence(0, 1)
    );

    expect(merged.detail.event.status, 'lifecycle advances').toBe('closing');
    expect(merged.detail.event.version, 'counting does not roll back').toBe(20);
    expect(merged.detail.occupancy.global).toBe(14);
  });
});

describe('the fence survives having no baseline to apply a push to', () => {
  it('does not desynchronise when a push arrives before the first view exists', () => {
    // dashboardView = null, generation ref = 0
    //   /state starts        -> generationAtStart 0
    //   event-status arrives -> ref becomes 1, but there is no view to
    //                           apply it to, so nothing is stored
    //   /state returns       -> generationAtEnd 1
    //
    // The response is the only thing that can establish a baseline, so it
    // does — but the fence saw the push, so its lifecycle is not trusted,
    // and the very next poll must be able to correct it.
    const first = mergeSupervisionRefresh(
      null,
      detailWith(20, 14, { status: 'live' }),
      overtakenFence(0, 1, 1)
    );
    expect(first.detail.event.status, 'a baseline is still established').toBe('live');

    // The next poll runs entirely after the push: start and end agree.
    const second = mergeSupervisionRefresh(first, detailWith(20, 14, { status: 'closing' }), openFence(1, 2));

    expect(second.detail.event.status, 'the fence must not be stuck rejecting').toBe('closing');
  });

  it('keeps converging on every later poll, not just the next one', () => {
    let held = mergeSupervisionRefresh(null, detailWith(20, 14, { status: 'live' }), overtakenFence(0, 1, 1));
    held = mergeSupervisionRefresh(held, detailWith(20, 14, { status: 'live' }), openFence(1, 2));
    held = mergeSupervisionRefresh(held, detailWith(20, 14, { status: 'closing' }), openFence(1, 3));

    expect(held.detail.event.status).toBe('closing');
  });

  it('converges after A → B when B’s push precedes B’s first detail', () => {
    //   held view describes A
    //   operator selects B; B's /state starts
    //   B's event-status arrives before B's first detail — it cannot be
    //   applied, because the held view is still A's
    //   B's /state establishes B
    const viewOfA = view(detail(20, 14));
    const detailOfB: EventDetailResponse = {
      ...detailWith(4, 2, { status: 'live' }),
      event: { ...eventModel(4, 'live'), id: OTHER_EVENT_ID },
    };

    const establishedB = mergeSupervisionRefresh(viewOfA, detailOfB, overtakenFence(0, 1, 1));
    expect(establishedB.detail.event.id).toBe(OTHER_EVENT_ID);

    // B's next poll, wholly after the push, carries the transition.
    const closingB: EventDetailResponse = {
      ...detailWith(4, 2, { status: 'closing' }),
      event: { ...eventModel(4, 'closing'), id: OTHER_EVENT_ID },
    };
    const converged = mergeSupervisionRefresh(establishedB, closingB, openFence(1, 2));

    expect(converged.detail.event.status, 'B converges without a stuck fence').toBe('closing');
  });

  it('a push for another event must not be allowed to move this event’s fence', () => {
    // The caller asks this *before* it touches the counter. Bumping first
    // and checking identity afterwards would let a message about some other
    // event invalidate an in-flight refresh of the one on screen, whose two
    // fence readings would then disagree for no reason at all.
    expect(isLifecyclePushForEvent({ eventId: EVENT_ID }, EVENT_ID)).toBe(true);
    expect(isLifecyclePushForEvent({ eventId: OTHER_EVENT_ID }, EVENT_ID)).toBe(false);
    expect(isLifecyclePushForEvent({ eventId: EVENT_ID }, null)).toBe(false);
  });

  it('a message for another event leaves the held lifecycle untouched', () => {
    const held = view(detail(20, 14));
    const next = applyLifecycleMessage(held, {
      eventId: OTHER_EVENT_ID,
      status: 'closed',
      timestampMs: 9_000,
    });

    expect(next?.detail.event.status).toBe('live');
    expect(next, 'the held view is returned unchanged').toBe(held);
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

    expect(acceptSupervisionResponse(prev, lateForOldEvent, OTHER_EVENT_ID, openFence(0, 1))).toBeNull();
  });

  it('drops any response once no event is selected', () => {
    expect(acceptSupervisionResponse(null, detail(1, 0), null, openFence(0, 1))).toBeNull();
  });

  it('accepts a response for the event currently on screen', () => {
    const held = view(detail(20, 14));
    const merged = acceptSupervisionResponse(held, detail(21, 15), EVENT_ID, openFence(0, 1));
    expect(merged?.detail.event.version).toBe(21);
  });

  it('still refuses to roll counting back for the event on screen', () => {
    const held = view(detail(20, 14));
    const merged = acceptSupervisionResponse(
      held,
      detail(18, 9, { syncQuality: 'uncertain' }),
      EVENT_ID,
      openFence(0, 1)
    );
    expect(merged?.detail.occupancy.global).toBe(14);
    expect(merged?.detail.syncQuality).toBe('uncertain');
  });
});

describe('applyLiveState — counting frames', () => {
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
