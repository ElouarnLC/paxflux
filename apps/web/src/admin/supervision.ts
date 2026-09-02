import {
  CompactEventState,
  EventDetailResponse,
  EventDeviceSummary,
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
 * What the dashboard holds: a response, plus the epoch of the lifecycle
 * status inside it.
 *
 * The epoch has to be carried separately because it is not derivable from
 * the response once merged: after a merge the displayed status may come from
 * one channel and the occupancy from another.
 */
export interface DashboardView {
  detail: EventDetailResponse;
  /**
   * A server-clock instant at which `detail.event.status` was true.
   *
   * See `lifecycleEpochOf` for why every source can produce one and why they
   * are comparable with each other.
   */
  lifecycleAtMs: number;
}

/**
 * The lifecycle epoch of an HTTP `/state` response.
 *
 * `event.updatedAtMs` is a property of the row that was read, so it can
 * never be newer than the read itself. That is exactly what the race needs:
 * a response whose row was captured *before* a transition carries the
 * pre-transition timestamp, however late the response arrives. Minting the
 * epoch from `Date.now()` when the response is built or received would
 * instead stamp a stale reading with a fresh time, which is the bug.
 *
 * Every lifecycle transition in `routes/events.ts` — start, begin-closing,
 * close, force-close, reopen and archive — writes `updatedAtMs: now` in the
 * same update that sets the new status, so the timestamp always belongs to
 * the status beside it. Counting also bumps it, which is harmless: it moves
 * the epoch forward while carrying the status unchanged.
 */
function lifecycleEpochOf(detail: EventDetailResponse): number {
  return detail.event.updatedAtMs;
}

/** Wraps a first response, before anything has been merged into it. */
export function viewFromDetail(detail: EventDetailResponse): DashboardView {
  return { detail, lifecycleAtMs: lifecycleEpochOf(detail) };
}

/**
 * Merges a periodic `/state` refresh into what the dashboard already holds.
 *
 * The refresh exists for the supervision fields — devices and sync quality —
 * because those change without any new state frame: a device goes offline
 * when its heartbeat *stops*, and silence produces no SSE event. But the
 * same response also carries counting state and a lifecycle status, either
 * of which SSE may already have moved past while this request was in flight.
 *
 * Three groups, ordered by three different rules, because they genuinely
 * move on different clocks:
 *
 *  - **supervision** (devices, sync quality, topology) is taken from the
 *    response unconditionally: it is the only source for it;
 *
 *  - **counting** (occupancy, version, capacity) is ordered by
 *    `event.version`, the counter SSE carries as `state.version`;
 *
 *  - **lifecycle** (status) is ordered by a wall-clock epoch, *not* by
 *    version — because a transition does not bump the version at all. The
 *    server broadcasts `live → closing` with `version: eventRecord.version`
 *    unchanged, so an HTTP response captured before the transition and an
 *    SSE frame minted after it are indistinguishable by version. Ordering
 *    lifecycle by version would let the late response put the dashboard back
 *    to `live`.
 *
 * The epoch is a real instant rather than a rank over status values, which
 * matters because the statuses are not monotonic: `reopen` takes an event
 * from `closed` back to `live`, so any "later status wins" table would be
 * wrong in exactly the case an operator most needs to see.
 */
export function mergeSupervisionRefresh(
  prev: DashboardView | null,
  incoming: EventDetailResponse
): DashboardView {
  // Nothing held, or a different event entirely: version counters are
  // per-event, so there is nothing meaningful to compare against.
  if (!prev || prev.detail.event.id !== incoming.event.id) return viewFromDetail(incoming);

  const incomingEpoch = lifecycleEpochOf(incoming);
  const lifecycleIsNewer = incomingEpoch >= prev.lifecycleAtMs;
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
        // Lifecycle, on its own clock.
        status: lifecycleIsNewer ? incoming.event.status : prev.detail.event.status,
        updatedAtMs: lifecycleIsNewer ? incoming.event.updatedAtMs : prev.detail.event.updatedAtMs,
      },
      occupancy: countingIsNewer ? incoming.occupancy : prev.detail.occupancy,
    },
    lifecycleAtMs: lifecycleIsNewer ? incomingEpoch : prev.lifecycleAtMs,
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
  currentEventId: string | null
): DashboardView | null {
  if (currentEventId === null || incoming.event.id !== currentEventId) return null;
  return mergeSupervisionRefresh(prev, incoming);
}

/**
 * Applies an SSE state frame to what the dashboard holds.
 *
 * Both clocks are honoured here too. Counting is ordered by `version`, and
 * the frame's lifecycle by `serverTimeMs` — the instant the server minted
 * the frame, and therefore an instant at which the status it carries was
 * true, on the same clock as `updatedAtMs`.
 *
 * A frame can never claim a *later* epoch while carrying an *older* status:
 * a frame minted after a transition reads the new status, and one minted
 * before it has an epoch below that transition's `updatedAtMs`. That is what
 * makes the two sources safe to compare against each other.
 */
export function applyLiveState(
  prev: DashboardView | null,
  state: CompactEventState
): DashboardView | null {
  if (!prev) return prev;

  const countingIsNewer = state.version >= prev.detail.event.version;
  const lifecycleIsNewer = state.serverTimeMs >= prev.lifecycleAtMs;
  if (!countingIsNewer && !lifecycleIsNewer) return prev;

  const spaceOccupancies: Record<string, number> = {};
  for (const space of state.spaces) {
    spaceOccupancies[space.id] = space.occupancy;
  }

  return {
    detail: {
      ...prev.detail,
      occupancy: countingIsNewer
        ? { global: state.eventOccupancy, spaces: spaceOccupancies }
        : prev.detail.occupancy,
      event: {
        ...prev.detail.event,
        status: lifecycleIsNewer ? state.eventStatus : prev.detail.event.status,
        capacity: countingIsNewer ? state.eventCapacity : prev.detail.event.capacity,
        version: countingIsNewer ? state.version : prev.detail.event.version,
      },
    },
    lifecycleAtMs: lifecycleIsNewer ? state.serverTimeMs : prev.lifecycleAtMs,
  };
}
