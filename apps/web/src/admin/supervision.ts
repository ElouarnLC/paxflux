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
 * Merges a periodic `/state` refresh into what the dashboard already holds.
 *
 * The refresh exists for the supervision fields — devices and sync quality —
 * because those change without any new state frame: a device goes offline
 * when its heartbeat *stops*, and silence produces no SSE event. But the
 * same response also carries occupancy and the event's version, which SSE
 * may already have moved past while this request was in flight.
 *
 * So the two halves are merged on different rules. Supervision is taken from
 * the response unconditionally — it is the only source for it, and the
 * server is authoritative. Counting state is taken only when the response is
 * at least as fresh as what is held, by the same `version` counter SSE
 * carries (`getCompactEventState` reads it from the event record, so the two
 * are the same number). A response minted before a frame already applied is
 * older, and is not allowed to roll the gauge back.
 *
 * `>=` rather than `>` on purpose: a lifecycle transition does not bump
 * `version`, so an equal-version refresh is a fresher read of the event
 * record and must be able to carry `live → closing`.
 */
export function mergeSupervisionRefresh(
  prev: EventDetailResponse | null,
  incoming: EventDetailResponse
): EventDetailResponse {
  // Nothing held, or a different event entirely: version counters are
  // per-event, so there is nothing meaningful to compare against.
  if (!prev || prev.event.id !== incoming.event.id) return incoming;

  if (incoming.event.version >= prev.event.version) return incoming;

  return {
    ...incoming,
    // Held back: SSE has already carried this event past the moment this
    // response describes.
    event: prev.event,
    occupancy: prev.occupancy,
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
  prev: EventDetailResponse | null,
  incoming: EventDetailResponse,
  currentEventId: string | null
): EventDetailResponse | null {
  if (currentEventId === null || incoming.event.id !== currentEventId) return null;
  return mergeSupervisionRefresh(prev, incoming);
}

/**
 * Applies an SSE state frame to what the dashboard holds.
 *
 * Guarded by the same ordering, in the other direction: frames delivered out
 * of order over a reconnected stream must not move the gauge backwards
 * either.
 */
export function applyLiveState(
  prev: EventDetailResponse | null,
  state: CompactEventState
): EventDetailResponse | null {
  if (!prev) return prev;
  if (state.version < prev.event.version) return prev;

  const spaceOccupancies: Record<string, number> = {};
  for (const space of state.spaces) {
    spaceOccupancies[space.id] = space.occupancy;
  }

  return {
    ...prev,
    occupancy: { global: state.eventOccupancy, spaces: spaceOccupancies },
    event: {
      ...prev.event,
      status: state.eventStatus,
      capacity: state.eventCapacity,
      version: state.version,
    },
  };
}
