import {
  CompactEventState,
  DeviceBootstrapResponse,
  EventStatus,
  OutboxActionOwner,
} from '@paxflux/shared';
import { localDb } from './db.js';

/**
 * The one place authoritative state is written, and the one place the
 * counter reads its starting point from.
 *
 * Before this, `bootstrap_config.lastState` and `last_server_state` were two
 * competing copies of the same value written by two different code paths:
 * bootstrap wrote the first, SSE wrote the second, and startup read only the
 * first — so a counter restarted from whatever the state was when it paired,
 * discarding everything it had been told since. Every arrival now goes
 * through `persistAuthoritativeState`.
 */

export type StateSource = 'bootstrap' | 'batch' | 'sse';

/** A lifecycle transition and the server time that carried it. */
export interface LifecycleMarker {
  status: EventStatus;
  atMs: number;
}

export interface LocalSnapshot {
  bootstrap: DeviceBootstrapResponse | null;
  /**
   * Set when this device has paired but has no configuration yet. The
   * counter must stay non-operational rather than fall back to whatever it
   * was before — that identity no longer matches the cookie.
   */
  awaitingConfigurationFor: string | null;
  state: CompactEventState | null;
  /**
   * The last `event-status` transition seen, with its timestamp.
   *
   * Returned as a marker rather than a resolved status because the caller
   * keeps receiving newer state frames: a marker is only authoritative
   * while it is more recent than the frame it is compared against, and
   * collapsing it to a status here would freeze a stale `live` over a
   * `closing` that arrived later by another route.
   */
  lifecycle: LifecycleMarker | null;
}

/**
 * True when `incoming` is at least as fresh as `existing`.
 *
 * `version` first, then `serverTimeMs`. The timestamp is not a tie-breaking
 * nicety: a lifecycle transition does not bump `event.version`, so a
 * response minted before `live → closing` and delivered after it carries the
 * *same* version as the truth — and would resurrect `live` if version alone
 * decided.
 */
function isAtLeastAsFresh(incoming: CompactEventState, existing: CompactEventState): boolean {
  if (incoming.version !== existing.version) return incoming.version > existing.version;
  return incoming.serverTimeMs >= existing.serverTimeMs;
}

/**
 * Stores a state only if it is at least as recent as the one already held,
 * so an SSE frame and a batch response arriving out of order over different
 * connections cannot make the gauge jump backwards.
 *
 * A state for a different event replaces whatever is stored unconditionally:
 * version counters are per-event, so comparing across events is meaningless.
 */
export async function persistAuthoritativeState(
  eventId: string,
  state: CompactEventState,
  source: StateSource
): Promise<boolean> {
  return localDb.transaction('rw', localDb.event_state, async () => {
    const existing = await localDb.event_state.get('current');

    if (existing && existing.eventId === eventId && !isAtLeastAsFresh(state, existing.state)) {
      console.debug(
        `Ignoring stale ${source} state v${state.version}@${state.serverTimeMs}; ` +
          `holding v${existing.state.version}@${existing.state.serverTimeMs}`
      );
      return false;
    }

    await localDb.event_state.put({
      key: 'current',
      eventId,
      state,
      updatedAtMs: Date.now(),
      // A state frame for another event replaces the record wholesale, so
      // its lifecycle marker must not be carried over.
      lifecycleStatus: existing && existing.eventId === eventId ? existing.lifecycleStatus : undefined,
      lifecycleAtMs: existing && existing.eventId === eventId ? existing.lifecycleAtMs : undefined,
    });
    return true;
  });
}

/**
 * Records an `event-status` transition durably.
 *
 * Without this, `live → closing` lived only in React state: a reload with no
 * network fell back to whatever status the last stored frame carried, and a
 * device could go on accepting taps into a closing event. Kept newest-wins
 * by the server timestamp the transition carried.
 */
export async function persistLifecycleStatus(
  eventId: string,
  status: EventStatus,
  atMs: number
): Promise<boolean> {
  return localDb.transaction('rw', localDb.event_state, async () => {
    const existing = await localDb.event_state.get('current');
    if (!existing || existing.eventId !== eventId) {
      // Nothing to attach it to: a lifecycle marker without the state it
      // qualifies would be read under the wrong event.
      return false;
    }
    if (existing.lifecycleAtMs !== undefined && existing.lifecycleAtMs > atMs) return false;

    await localDb.event_state.put({
      ...existing,
      lifecycleStatus: status,
      lifecycleAtMs: atMs,
    });
    return true;
  });
}

/**
 * The status to act on: the stored state's, unless a lifecycle transition
 * arrived after the moment that state describes.
 */
export function resolveEffectiveStatus(
  state: CompactEventState,
  lifecycle: LifecycleMarker | null
): EventStatus {
  if (lifecycle && lifecycle.atMs >= state.serverTimeMs) return lifecycle.status;
  return state.eventStatus;
}

/**
 * Stores the stable pairing configuration and its state in one step, so a
 * fresh bootstrap can never leave the two describing different pairings.
 */
export async function persistBootstrap(bootstrap: DeviceBootstrapResponse): Promise<boolean> {
  // A bootstrap request in flight when a re-pairing happens comes back
  // describing the *previous* device session. Committing it would undo the
  // handoff and put the retired identity back in charge — the very thing
  // `beginPairingHandoff` exists to prevent — so the commit is conditional
  // on the response describing the identity this device is currently
  // waiting for (or already has).
  const accepted = await localDb.transaction('rw', localDb.device_config, async () => {
    const config = await localDb.device_config.get('current');
    const expectedSessionId = config?.pendingSessionId ?? config?.bootstrap?.deviceSession.id ?? null;

    if (expectedSessionId !== null && expectedSessionId !== bootstrap.deviceSession.id) {
      console.debug(
        `Ignoring a bootstrap for session ${bootstrap.deviceSession.id}; this device expects ${expectedSessionId}`
      );
      return false;
    }

    await localDb.device_config.put({
      key: 'current',
      bootstrap,
      updatedAtMs: Date.now(),
    });
    return true;
  });

  if (accepted) {
    await persistAuthoritativeState(bootstrap.event.id, bootstrap.state, 'bootstrap');
  }
  return accepted;
}

/**
 * Retires the previous pairing the instant `/device/pair` succeeds.
 *
 * From that moment the cookie names a different device session, so the
 * stored configuration describes an identity this browser no longer has. It
 * is dropped immediately rather than when the new bootstrap arrives —
 * otherwise a bootstrap that never succeeds leaves the old identity running
 * the counter, creating taps and heartbeats under someone else's cookie.
 *
 * The outbox is deliberately untouched: those are real counts, and they are
 * quarantined by the ownership check rather than deleted.
 */
export async function beginPairingHandoff(deviceSessionId: string): Promise<void> {
  await localDb.device_config.put({
    key: 'current',
    pendingSessionId: deviceSessionId,
    updatedAtMs: Date.now(),
  });
}

/**
 * Reads back what this device knows without the network: its configuration
 * and the newest state it ever received.
 *
 * A stored state belonging to another event is not returned — it would be
 * describing spaces this pairing does not even have.
 */
export async function loadSnapshot(): Promise<LocalSnapshot> {
  const config = await localDb.device_config.get('current');
  if (!config || !config.bootstrap) {
    return {
      bootstrap: null,
      awaitingConfigurationFor: config?.pendingSessionId ?? null,
      state: null,
      lifecycle: null,
    };
  }

  const stored = await localDb.event_state.get('current');
  if (!stored || stored.eventId !== config.bootstrap.event.id) {
    return {
      bootstrap: config.bootstrap,
      awaitingConfigurationFor: null,
      state: config.bootstrap.state,
      lifecycle: null,
    };
  }

  return {
    bootstrap: config.bootstrap,
    awaitingConfigurationFor: null,
    state: stored.state,
    lifecycle:
      stored.lifecycleStatus && stored.lifecycleAtMs !== undefined
        ? { status: stored.lifecycleStatus, atMs: stored.lifecycleAtMs }
        : null,
  };
}

/**
 * The identity currently paired, together with the checkpoint endpoints it
 * counts across.
 *
 * Read as one unit because the two must always describe the same pairing:
 * an action is stamped with the identity and projected across the endpoints,
 * and taking them from separate reads could straddle a re-pairing.
 */
export interface CurrentPairing {
  owner: OutboxActionOwner;
  spaceAId: string;
  spaceBId: string;
}

export async function currentPairing(): Promise<CurrentPairing | null> {
  const config = await localDb.device_config.get('current');
  // No configuration means no identity to act as — including mid-handoff,
  // where a `pendingSessionId` is recorded but nothing is known about it yet.
  if (!config?.bootstrap) return null;
  const { bootstrap } = config;
  return {
    owner: {
      deviceSessionId: bootstrap.deviceSession.id,
      eventId: bootstrap.event.id,
      checkpointId: bootstrap.checkpoint.id,
    },
    spaceAId: bootstrap.checkpoint.spaceAId,
    spaceBId: bootstrap.checkpoint.spaceBId,
  };
}

/**
 * The closing epoch this device has seen, from the newest authoritative
 * state it holds, or null if the event is not closing as far as it knows.
 *
 * Echoed back on every report. A device that has not seen the transition
 * names nothing, and so confirms nothing — which is the safe direction.
 */
export async function observedClosingEpoch(): Promise<number | null> {
  const stored = await localDb.event_state.get('current');
  return stored?.state.closingStartedAtMs ?? null;
}

/** The identity currently paired on this device, or null if none is. */
export async function currentOwner(): Promise<OutboxActionOwner | null> {
  const config = await localDb.device_config.get('current');
  if (!config?.bootstrap) return null;
  return {
    deviceSessionId: config.bootstrap.deviceSession.id,
    eventId: config.bootstrap.event.id,
    checkpointId: config.bootstrap.checkpoint.id,
  };
}
