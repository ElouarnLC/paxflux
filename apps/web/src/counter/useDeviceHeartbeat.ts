import { useEffect, useRef, useState } from 'react';
import { DEVICE_HEARTBEAT_INTERVAL_MS, DeviceHeartbeatResponse } from '@paxflux/shared';
import { apiFetch } from '../api/client.js';
import { getOwnerUnresolvedActionsCount } from '../offline/outbox.js';
import { currentOwner, observedClosingEpoch, persistCurrentDeviceLabel } from '../offline/snapshot.js';
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
        const owner = await currentOwner();
        if (!owner) {
          // Nothing is paired — or a pairing is in flight and its
          // configuration has not arrived. There is no identity to report
          // as, and reporting as the previous one is exactly the mistake
          // this guards against.
          if (!cancelled) timer = setTimeout(beat, DEVICE_HEARTBEAT_INTERVAL_MS);
          return;
        }

        const pendingCount = await getOwnerUnresolvedActionsCount(owner);
        // `lastClientSequence` is intentionally omitted: the local model
        // tracks the next sequence to assign, not the last one the server
        // acknowledged, and reporting the former as the latter would tell
        // the supervisor something the client cannot actually vouch for.
        const response = await apiFetch<DeviceHeartbeatResponse>('/api/v1/device/heartbeat', {
          method: 'POST',
          body: JSON.stringify({
            pendingCount,
            // The cookie authenticates a session; this names the one this
            // report is about. In a re-pairing window they disagree, and
            // the server refuses rather than writing one device's pending
            // count onto another's session.
            expectedDeviceSessionId: owner.deviceSessionId,
            // Same fail-closed rule as the batch endpoint: a device that
            // has not seen the closing transition names nothing, and so
            // confirms nothing.
            observedClosingStartedAtMs: await observedClosingEpoch(),
            appVersion: CLIENT_APP_VERSION,
          }),
        });

        // The beat brings the canonical label back with it, so a staff
        // rename reaches an open counter without a second polling loop.
        //
        // Guarded twice over. The server already refuses to answer for a
        // session the cookie does not authenticate, and this refuses to
        // apply an answer that does not name the identity this beat was
        // sent for — a response in flight across a re-pairing describes a
        // device this browser has retired. `persistCurrentDeviceLabel`
        // checks the stored identity a third time before writing, and
        // writes nothing but the label.
        //
        // Nothing is returned to the caller: `device_config` is read by
        // CounterView through a Dexie live query, so writing the label is
        // already how the screen learns about it. A callback would be a
        // second path to the same render.
        if (response?.deviceSession && response.deviceSession.id === owner.deviceSessionId) {
          await persistCurrentDeviceLabel(response.deviceSession.id, response.deviceSession.label);
        }
      } catch (err) {
        const problem = typeof err === 'object' && err !== null ? (err as { status?: number; code?: string }) : {};
        const isRevoked = problem.status === 401;
        // A 409 on session identity means this device is reporting as a
        // session the cookie no longer authenticates — a re-pairing whose
        // configuration never arrived. Continuing to count would build up
        // taps under an identity the server has already disowned.
        const isWrongSession = problem.status === 409 && problem.code === 'DEVICE_SESSION_MISMATCH';
        if (isRevoked || isWrongSession) {
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
