import { useEffect, useRef, useState } from 'react';
import { DEVICE_HEARTBEAT_INTERVAL_MS } from '@paxflux/shared';
import { apiFetch } from '../api/client.js';
import { getOwnerUnresolvedActionsCount } from '../offline/outbox.js';
import { currentOwner } from '../offline/snapshot.js';
import { CLIENT_APP_VERSION } from '../version.js';

export type HeartbeatState = 'idle' | 'running' | 'session-invalid';

/**
 * Keeps an open counter visible as online for supervision.
 *
 * The server marks a device offline after DEVICE_OFFLINE_THRESHOLD_MS of
 * silence, and before Phase 5 the only things that ever refreshed
 * `lastSeenAtMs` were bootstrap and action batches — so a counter left open
 * at a quiet door dropped to "Hors ligne" within 45s and made the closing
 * sync gate lie. This beats on its own, independently of any tap.
 *
 * Deliberate properties:
 *  - one timer only: rescheduled from the completion of each beat, so a
 *    re-render or a reconnection can never stack two loops;
 *  - never overlapping: the next beat is scheduled only once the previous
 *    request has settled, so a slow network cannot pile requests up;
 *  - not gated on `navigator.onLine`, which says the interface is up, not
 *    that this server is reachable. A failed beat is simply retried on the
 *    next tick, so recovery needs no separate "back online" path;
 *  - never queued in the outbox: a heartbeat is not a business action, and
 *    replaying a stale one would be meaningless.
 */
export function useDeviceHeartbeat(enabled: boolean): HeartbeatState {
  const [state, setState] = useState<HeartbeatState>('idle');
  // Read through a ref so a state change never restarts the timer loop.
  const sessionInvalidRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    sessionInvalidRef.current = false;
    setState('running');

    const beat = async () => {
      try {
        // Unresolved, not retryable: a device still holding a refused count
        // is not drained, and reporting only what the engine can still send
        // would tell the supervisor otherwise — and let a normal `/close`
        // through. Scoped to the identity currently paired, so a previous
        // pairing's stranded queue (visible locally, and a real problem)
        // cannot block the closing of an event this session has drained.
        const pendingCount = await getOwnerUnresolvedActionsCount(await currentOwner());
        // `lastClientSequence` is intentionally omitted: the local model
        // tracks the next sequence to assign, not the last one the server
        // acknowledged, and reporting the former as the latter would tell
        // the supervisor something the client cannot actually vouch for.
        await apiFetch('/api/v1/device/heartbeat', {
          method: 'POST',
          body: JSON.stringify({ pendingCount, appVersion: CLIENT_APP_VERSION }),
        });
      } catch (err) {
        const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status: number }).status : 0;
        if (status === 401) {
          // Revoked or expired session: this device is no longer allowed to
          // report. Stop beating and let the counter lock itself.
          sessionInvalidRef.current = true;
          if (!cancelled) setState('session-invalid');
          return;
        }
        // Anything else (offline, server hiccup) is transient: stay silent
        // and try again on the next tick.
        console.debug('Heartbeat failed, will retry:', err);
      }

      if (!cancelled && !sessionInvalidRef.current) {
        timer = setTimeout(beat, DEVICE_HEARTBEAT_INTERVAL_MS);
      }
    };

    beat();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);

  return state;
}
