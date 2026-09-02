import {
  CompactEventState,
  EventDetailResponse,
  EventDeviceSummary,
  EventStatus,
  SyncQuality,
} from '@paxflux/shared';

/**
 * The supervision half of the dashboard, as pure decisions.
 *
 * Two things live here rather than inside the component, because both are
 * about correctness rather than presentation and neither needs a DOM to be
 * checked:
 *
 *  - how a periodic `/state` refresh is merged into what the screen already
 *    holds, so that fixing stale *device* state cannot introduce stale
 *    *counting* state;
 *  - what the sync-quality card is allowed to claim, given the server's
 *    verdict and the devices it was computed from.
 */

/**
 * The status vocabulary keys this module can return.
 *
 * A subset of `StatusKey` in `components/paxflux/status`, restated here so
 * this module stays free of UI imports and can be unit-tested. The wire
 * calls the worst case `uncertain`; the operator's vocabulary calls it
 * `unreliable`.
 */
export type SyncQualityStatusKey = 'reliable' | 'degraded' | 'unreliable';

const WIRE_TO_STATUS: Record<SyncQuality, SyncQualityStatusKey> = {
  reliable: 'reliable',
  degraded: 'degraded',
  uncertain: 'unreliable',
};

export interface SyncQualitySummary {
  /** The server's verdict, in the operator's vocabulary. Never re-derived. */
  status: SyncQualityStatusKey;
  /** "2 appareils en ligne sur 2", or the no-device case. */
  presence: string;
  /** Pending actions, when there is a device that could hold any. */
  pending: string | null;
  /** What the verdict actually means, in the terms the server computed it. */
  detail: string;
}

function plural(count: number, singular: string, plural: string): string {
  return count > 1 ? plural : singular;
}

/**
 * Describes the server's sync verdict without overstating it.
 *
 * The server's rule (`GET /events/:id/state`) is, exactly:
 *
 *   uncertain  more than one device offline, or every device offline
 *              (with at least one device);
 *   degraded   otherwise, if any device is offline or any action is pending;
 *   reliable   otherwise.
 *
 * Two consequences the previous copy got wrong. An event with **no devices
 * at all** is `reliable` — nothing is offline and nothing is pending — and
 * "Tous les appareils sont connectés et à jour" then claims a fleet that
 * does not exist. And a single offline device is `uncertain`, not "plusieurs
 * appareils déconnectés": one device can be the only device.
 *
 * The verdict itself is passed through untouched; only what is said about it
 * is derived from the devices it was computed from.
 */
export function summariseSyncQuality(
  quality: SyncQuality,
  devices: EventDeviceSummary[]
): SyncQualitySummary {
  const status = WIRE_TO_STATUS[quality];
  const total = devices.length;
  const online = devices.filter((device) => device.isOnline).length;
  const offline = total - online;
  const totalPending = devices.reduce((sum, device) => sum + device.lastPendingCount, 0);

  if (total === 0) {
    // The server had nothing to judge. Saying so is the honest neutral
    // state; claiming every device is connected is not.
    return {
      status,
      presence: 'Aucun appareil appairé',
      pending: null,
      detail: 'Aucun appareil de comptage n’est appairé sur cet événement : il n’y a rien à synchroniser.',
    };
  }

  const presence = `${online} ${plural(online, 'appareil', 'appareils')} en ligne sur ${total}`;
  const pending =
    totalPending === 0
      ? 'Aucune action en attente'
      : `${totalPending} ${plural(totalPending, 'action', 'actions')} en attente`;

  return { status, presence, pending, detail: describeVerdict(status, online, offline, totalPending) };
}

function describeVerdict(
  status: SyncQualityStatusKey,
  online: number,
  offline: number,
  totalPending: number
): string {
  if (status === 'reliable') {
    return 'Tous les appareils appairés répondent et ont transmis leurs comptages.';
  }

  if (status === 'degraded') {
    if (offline > 0 && totalPending > 0) {
      return 'Un appareil ne répond plus et des comptages n’ont pas encore atteint le serveur.';
    }
    if (offline > 0) {
      return 'Un appareil ne répond plus : ses derniers comptages peuvent manquer à la jauge.';
    }
    return 'Toutes les portes répondent, mais des comptages n’ont pas encore été confirmés par le serveur.';
  }

  // uncertain: more than one device offline, or every device offline.
  if (online === 0) {
    return 'Aucun appareil ne répond : la jauge peut être incomplète tant qu’ils ne se reconnectent pas.';
  }
  return 'Plusieurs appareils ne répondent plus : la jauge globale peut être incomplète.';
}

/**
 * What the dashboard holds: a response, plus the two counters that decide
 * which source may set the lifecycle next.
 *
 * Neither is a clock. `Date.now()` was the previous ordering signal and it
 * cannot carry this: a server clock that steps backwards makes a genuinely
 * later transition look older, and once the event is `closed` nothing
 * guarantees a future mutation ever writes a timestamp above the held one —
 * so the dashboard could sit on `closing` indefinitely rather than
 * converging at the next poll. Equal timestamps are no better: a count and a
 * transition can share a millisecond, so an equal value proves nothing about
 * which happened first.
 */
export interface DashboardView {
  detail: EventDetailResponse;
  /**
   * Incremented every time a pushed lifecycle transition is applied.
   *
   * A refresh records this when it *starts*. If it differs when the response
   * arrives, a transition overtook the request in flight and its lifecycle
   * is stale by construction — whatever its timestamps say.
   */
  lifecycleGeneration: number;
  /**
   * The sequence number of the newest refresh whose lifecycle was applied.
   *
   * Two refreshes can be in flight at once — the poll, and the one
   * `LifecycleControls` fires through `onChanged` after a transition — with
   * no push between them to move the generation. `archive` is exactly that
   * case: it writes the row, revokes the device sessions and calls
   * `closeAllForEvent`, broadcasting no `event-status` at all. Ordering by
   * request sequence stops the earlier response from winning.
   */
  lifecycleRequestSeq: number;
}

/**
 * What a refresh observed when it started, carried back to its response.
 */
export interface LifecycleFence {
  /** `lifecycleGeneration` at the moment the request was issued. */
  generationAtStart: number;
  /** Monotonic id of this request, from the dashboard's own counter. */
  requestSeq: number;
}

/** Wraps a first response, before anything has been merged into it. */
export function viewFromDetail(detail: EventDetailResponse, requestSeq = 0): DashboardView {
  return { detail, lifecycleGeneration: 0, lifecycleRequestSeq: requestSeq };
}

/**
 * Merges a periodic `/state` refresh into what the dashboard already holds.
 *
 * The refresh exists for the supervision fields — devices and sync quality —
 * because those change without any new state frame: a device goes offline
 * when its heartbeat *stops*, and silence produces no SSE event. But the
 * same response also carries counting state and a lifecycle status, either
 * of which may already have been superseded while the request was in flight.
 *
 * Three groups, three rules, because they genuinely move independently:
 *
 *  - **supervision** (devices, sync quality, topology) — taken from the
 *    response unconditionally: it is the only source for it;
 *
 *  - **counting** (occupancy, version, capacity) — ordered by
 *    `event.version`, the counter SSE carries as `state.version`;
 *
 *  - **lifecycle** (status) — accepted only when the response was not
 *    overtaken: no pushed transition landed while it was in flight, and no
 *    later refresh has already set the lifecycle. A transition does not bump
 *    `event.version`, so version cannot order it; and no timestamp is
 *    consulted, so no clock can misorder it.
 *
 * The refusal is never terminal, which is what makes convergence real: the
 * next poll carries a higher `requestSeq` and a fresh generation, so a
 * missed push is always picked up on the following refresh.
 */
export function mergeSupervisionRefresh(
  prev: DashboardView | null,
  incoming: EventDetailResponse,
  fence: LifecycleFence
): DashboardView {
  // Nothing held, or a different event entirely: version counters are
  // per-event, so there is nothing meaningful to compare against.
  if (!prev || prev.detail.event.id !== incoming.event.id) {
    return { detail: incoming, lifecycleGeneration: 0, lifecycleRequestSeq: fence.requestSeq };
  }

  const notOvertakenByPush = fence.generationAtStart === prev.lifecycleGeneration;
  const notOvertakenByRefresh = fence.requestSeq > prev.lifecycleRequestSeq;
  const lifecycleIsUsable = notOvertakenByPush && notOvertakenByRefresh;
  const countingIsNewer = incoming.event.version >= prev.detail.event.version;

  return {
    detail: {
      // Supervision, always.
      ...incoming,
      event: {
        ...incoming.event,
        // Counting, only if this response has not been overtaken.
        version: countingIsNewer ? incoming.event.version : prev.detail.event.version,
        capacity: countingIsNewer ? incoming.event.capacity : prev.detail.event.capacity,
        // Lifecycle, behind the fence. `updatedAtMs` travels with the
        // status it belongs to — it no longer decides anything, but the two
        // must not be left describing different moments.
        status: lifecycleIsUsable ? incoming.event.status : prev.detail.event.status,
        updatedAtMs: lifecycleIsUsable ? incoming.event.updatedAtMs : prev.detail.event.updatedAtMs,
      },
      occupancy: countingIsNewer ? incoming.occupancy : prev.detail.occupancy,
    },
    lifecycleGeneration: prev.lifecycleGeneration,
    lifecycleRequestSeq: lifecycleIsUsable ? fence.requestSeq : prev.lifecycleRequestSeq,
  };
}

/**
 * The whole decision a refresh response goes through, event identity first.
 *
 * `mergeSupervisionRefresh` compares two snapshots of the *same* event.
 * Before that comparison can mean anything, the response has to be about the
 * event currently on screen: switching the selector leaves the previous
 * event's request in flight, and it comes back describing an event the
 * operator is no longer looking at. That response is dropped, not merged —
 * adopting it would repaint the dashboard with another event's devices and
 * gauge.
 *
 * Returns `null` when the response must be ignored.
 */
export function acceptSupervisionResponse(
  prev: DashboardView | null,
  incoming: EventDetailResponse,
  currentEventId: string | null,
  fence: LifecycleFence
): DashboardView | null {
  if (currentEventId === null || incoming.event.id !== currentEventId) return null;
  return mergeSupervisionRefresh(prev, incoming, fence);
}

/**
 * Applies an SSE state frame — **counting only**.
 *
 * A state frame carries `eventStatus`, and an earlier revision of this file
 * used it, ordered by the frame's `serverTimeMs`. That was unsound at the
 * producer, and measurably so. `getCompactEventState` reads the event row,
 * issues two further queries, and only then calls `Date.now()`;
 * `/device/bootstrap` does the same across six reads. A transition
 * committing in that gap is invisible to the status already in hand but
 * earlier than the timestamp about to be stamped on it, so the frame carries
 * an **old status with a new epoch**. Racing a frame build against a
 * transition reproduces it 400 times out of 400
 * (`tests/integration/lifecycle-signal-provenance.test.ts`); the 50–100ms
 * coalescing window in `broadcastState` only widens the gap, and the batch
 * endpoint's fallback frame hardcodes `eventStatus: 'live'` outright.
 *
 * `serverTimeMs` is also load-bearing for offline freshness (Phase 6,
 * RC2-A), so it is left exactly as it is and simply not read for lifecycle.
 */
export function applyLiveState(
  prev: DashboardView | null,
  state: CompactEventState
): DashboardView | null {
  if (!prev) return prev;
  if (state.version < prev.detail.event.version) return prev;

  const spaceOccupancies: Record<string, number> = {};
  for (const space of state.spaces) {
    spaceOccupancies[space.id] = space.occupancy;
  }

  return {
    ...prev,
    detail: {
      ...prev.detail,
      occupancy: { global: state.eventOccupancy, spaces: spaceOccupancies },
      event: {
        ...prev.detail.event,
        // Deliberately no `status`: see above.
        capacity: state.eventCapacity,
        version: state.version,
      },
    },
  };
}

/** The lifecycle half of an `event-status` SSE message. */
export interface LifecycleMessage {
  eventId: string;
  status: EventStatus;
  timestampMs: number;
}

/**
 * Applies an `event-status` message — **lifecycle only**, authoritatively.
 *
 * This is the push channel for transitions, and it is taken at face value
 * rather than compared against anything. Two facts make that safe. Messages
 * are written straight to each client's stream by `broadcastMessage` in call
 * order, with no coalescing, so a single SSE connection delivers them in the
 * order the server produced them. And a reconnection replays nothing: the
 * stream opens with a `state` snapshot only, which carries no lifecycle
 * here — so there is no path by which a stale transition arrives late.
 *
 * `timestampMs` is carried for display and diagnostics; it is deliberately
 * not used to decide precedence, which is what makes a rolled-back server
 * clock harmless.
 *
 * The generation is supplied by the caller, which increments its own counter
 * as it dispatches the message, so a refresh that started before this point
 * can be recognised as overtaken.
 */
export function applyLifecycleMessage(
  prev: DashboardView | null,
  message: LifecycleMessage,
  generation: number
): DashboardView | null {
  if (!prev) return prev;
  // A message for another event says nothing about the one on screen, and
  // must not move the fence.
  if (message.eventId !== prev.detail.event.id) return prev;

  return {
    detail: {
      ...prev.detail,
      event: { ...prev.detail.event, status: message.status, updatedAtMs: message.timestampMs },
    },
    lifecycleGeneration: generation,
    lifecycleRequestSeq: prev.lifecycleRequestSeq,
  };
}
