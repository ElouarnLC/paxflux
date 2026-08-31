import {
  CompactEventState,
  DeviceBootstrapResponse,
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

export interface LocalSnapshot {
  bootstrap: DeviceBootstrapResponse | null;
  state: CompactEventState | null;
}

/**
 * Stores a state only if it is at least as recent as the one already held.
 *
 * `version` is the event's own monotonic counter, so it is the right
 * ordering: an SSE frame and a batch response can arrive out of order over
 * different connections, and applying the older one afterwards would make
 * the gauge jump backwards for no reason.
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

    if (existing && existing.eventId === eventId && existing.state.version > state.version) {
      console.debug(
        `Ignoring out-of-order ${source} state v${state.version}; already holding v${existing.state.version}`
      );
      return false;
    }

    await localDb.event_state.put({
      key: 'current',
      eventId,
      state,
      updatedAtMs: Date.now(),
    });
    return true;
  });
}

/**
 * Stores the stable pairing configuration and its state in one step, so a
 * fresh bootstrap can never leave the two describing different pairings.
 */
export async function persistBootstrap(bootstrap: DeviceBootstrapResponse): Promise<void> {
  await localDb.device_config.put({
    key: 'current',
    bootstrap,
    updatedAtMs: Date.now(),
  });
  await persistAuthoritativeState(bootstrap.event.id, bootstrap.state, 'bootstrap');
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
  if (!config) return { bootstrap: null, state: null };

  const stored = await localDb.event_state.get('current');
  const state = stored && stored.eventId === config.bootstrap.event.id ? stored.state : config.bootstrap.state;

  return { bootstrap: config.bootstrap, state };
}

/** The identity currently paired on this device, or null if none is. */
export async function currentOwner(): Promise<OutboxActionOwner | null> {
  const config = await localDb.device_config.get('current');
  if (!config) return null;
  return {
    deviceSessionId: config.bootstrap.deviceSession.id,
    eventId: config.bootstrap.event.id,
    checkpointId: config.bootstrap.checkpoint.id,
  };
}
