import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { localDb } from '../offline/db.js';
import {
  enqueueCountAction,
  enqueueReversalAction,
  getLastCountAction,
  retryRejectedAction,
  UndoCandidate,
} from '../offline/outbox.js';
import {
  LifecycleMarker,
  persistAuthoritativeState,
  persistBootstrap,
  persistLifecycleStatus,
  resolveEffectiveStatus,
} from '../offline/snapshot.js';
import {
  forgetConfirmedActionsOfOtherOwners,
  getConfirmedActions,
} from '../offline/confirmed-actions.js';
import { projectPendingActions, projectedSpaceOccupancy } from '../offline/projection.js';
import {
  describeOutboxError,
  isRetryable,
  needsReconciliation,
  sameOwner,
} from '../offline/outbox-state.js';
import { useSSE } from '../sse/useSSE.js';
import { useDeviceHeartbeat } from './useDeviceHeartbeat.js';
import { apiFetch } from '../api/client.js';
import {
  DeviceBootstrapResponse,
  Direction,
  EventStatus,
  ConfirmedActionRecord,
  OutboxActionOwner,
  OutboxActionRecord,
} from '@paxflux/shared';
import {
  WifiOff,
  RefreshCw,
  RotateCcw,
  AlertTriangle,
  Lock,
  CheckCircle2,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * What the operator is actually being told, kept distinct from "the browser
 * says it has an interface". A device can be `navigator.onLine` and still
 * hold counts the server has never seen.
 */
type SyncStatus = 'revoked' | 'reconciliation' | 'offline' | 'syncing' | 'synced';

/**
 * Minimal shape of the Screen Wake Lock API, which the configured DOM lib
 * does not declare. Narrow on purpose: only what this component uses.
 */
interface WakeLockSentinelLike {
  release(): Promise<void>;
}

function wakeLockApi(): { request(type: 'screen'): Promise<WakeLockSentinelLike> } | null {
  const candidate = (navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
  }).wakeLock;
  return candidate ?? null;
}

/**
 * Names a blocked action for the operator.
 *
 * A count made under a previous pairing must NOT be labelled with the
 * current checkpoint's wording: "ENTRÉE +1" and "→ VIP" describe a specific
 * door, and a direction only means something relative to the door it was
 * made at. Showing this door's label on another door's count would misstate
 * what is waiting to be reconciled.
 */
function describeBlockedAction(
  action: OutboxActionRecord,
  bootstrap: DeviceBootstrapResponse,
  owner: OutboxActionOwner | null
): string {
  if (action.type === 'reversal') return 'Annulation';

  const isThisPairing = owner !== null && sameOwner(action.owner, owner);
  if (!isThisPairing) {
    return action.owner?.checkpointId === bootstrap.checkpoint.id
      ? 'Comptage d’un appairage précédent de cet appareil'
      : 'Comptage effectué à une autre porte';
  }

  return action.direction === 'a_to_b' ? bootstrap.checkpoint.labelAToB : bootstrap.checkpoint.labelBToA;
}

/**
 * Haptic confirmation for a tap (SPEC §10.4). Failing is inconsequential —
 * the count is already recorded — and logging on every tap would be noise,
 * so the outcome is deliberately not surfaced.
 */
function vibrate(pattern: number | number[]): void {
  if (typeof navigator === 'undefined' || !navigator.vibrate) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some browsers throw when vibration is disabled by the user.
  }
}

export const CounterView: React.FC = () => {
  // The pairing configuration is read live from storage, not held in
  // component state. Two reasons, both load-bearing: a re-pairing retires
  // the previous configuration the instant the cookie changes, and every
  // open tab must stop acting as the old device at that moment — including
  // one the operator left open on another screen.
  const storedConfig = useLiveQuery(() => localDb.device_config.get('current'), []);
  const bootstrap: DeviceBootstrapResponse | null = storedConfig?.bootstrap ?? null;
  const awaitingConfigurationFor = storedConfig?.bootstrap ? null : (storedConfig?.pendingSessionId ?? null);
  // The authoritative state and the lifecycle marker are read live from
  // storage rather than mirrored into React state.
  //
  // Every writer — bootstrap, batch response, SSE frame — goes through the
  // same persistence funnel, so reading the result back is the only way the
  // screen cannot disagree with what the device actually holds. Mirroring
  // it into component state is how a stale `live`, restored at startup,
  // came to shadow a `closing` learnt later from a batch response.
  const storedSnapshot = useLiveQuery(() => localDb.event_state.get('current'), []);
  const [lastAction, setLastAction] = useState<UndoCandidate | null>(null);
  const [confirmedActions, setConfirmedActions] = useState<ConfirmedActionRecord[]>([]);
  const [isUndoing, setIsUndoing] = useState(false);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // One live query over the whole outbox: every count the screen needs is
  // derived from it, so they can never disagree with each other.
  const outboxActions =
    useLiveQuery(() => localDb.outbox_actions.orderBy('sequence').toArray(), []) ?? [];
  const unresolvedCount = outboxActions.length;
  const retryableCount = outboxActions.filter(isRetryable).length;
  const blockedActions = outboxActions.filter(needsReconciliation);

  // Track online/offline browser state
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Request Screen Wake Lock (Progressive enhancement per SPEC §10.8)
  useEffect(() => {
    let wakeLock: WakeLockSentinelLike | null = null;
    async function requestWakeLock() {
      const api = wakeLockApi();
      if (!api) return;
      try {
        wakeLock = await api.request('screen');
      } catch (err) {
        // Denied by the browser (unsupported, battery saver, no user
        // gesture). The counter works fine with the screen sleeping, so
        // this stays a best-effort enhancement rather than an error.
        console.debug('Screen wake lock refused:', err);
      }
    }
    requestWakeLock();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (wakeLock) {
        wakeLock.release().catch((err) => console.debug('Wake lock release failed:', err));
      }
    };
  }, []);

  // Startup: the local snapshot first, then the server if it answers.
  //
  // The snapshot is one config plus the newest authoritative state this
  // device ever received, from whichever channel carried it. Restarting
  // from the state captured at pairing time — as this used to — threw away
  // everything SSE had said since.
  useEffect(() => {
    async function init() {
      // Always attempt the refresh: `navigator.onLine` says the interface is
      // up, not that this server is reachable, so gating on it would skip a
      // refresh that would have worked. A failure just leaves the snapshot
      // in place, which is exactly the offline behaviour we want.
      try {
        const fresh = await apiFetch<DeviceBootstrapResponse>('/api/v1/device/bootstrap');
        // Refused when the response describes an identity this device is no
        // longer waiting for: a request in flight when a re-pairing happens
        // comes back describing the *previous* session, and committing it
        // would undo the handoff.
        const accepted = await persistBootstrap(fresh);
        if (!accepted) {
          console.debug('Bootstrap ignored: it does not describe the pairing this device awaits');
          return;
        }
        // A pairing change makes the previous session's remembered counts
        // none of this device's business: offering to undo one would build
        // a reversal under the wrong identity.
        await forgetConfirmedActionsOfOtherOwners({
          deviceSessionId: fresh.deviceSession.id,
          eventId: fresh.event.id,
          checkpointId: fresh.checkpoint.id,
        });
        // Nothing to mirror: the live query above picks the refreshed
        // snapshot up as soon as `persistBootstrap` has written it.
      } catch (err) {
        console.debug('Bootstrap refresh failed; running on the local snapshot:', err);
      }
    }

    init();
  }, []);

  // Periodic heartbeat, started once this device is bootstrapped (i.e.
  // authenticated). Independent of taps: an open counter at a quiet door
  // must still read as online for the supervisor.
  const heartbeatState = useDeviceHeartbeat(bootstrap !== null);
  const isSessionRevoked = heartbeatState === 'session-invalid';

  // SSE Stream for real-time state updates
  const { isConnected } = useSSE({
    url: '/api/v1/device/stream',
    // A revoked session must not keep — or keep reconnecting — a stream it
    // is no longer entitled to.
    enabled: isOnline && !isSessionRevoked,
    onState: (state) => {
      // Same persistence funnel as bootstrap and batch responses, so the
      // stored snapshot is always the newest state whatever delivered it —
      // and the live query re-renders from it.
      if (bootstrap) {
        void persistAuthoritativeState(bootstrap.event.id, state, 'sse').catch((err) => {
          console.debug('Could not persist the SSE state locally:', err);
        });
      }
    },
    onMessage: (message) => {
      if (message.type === 'event-status') {
        // Persisted, so the transition outlives this tab. Carrying its own
        // server timestamp is what lets it win over a state frame minted
        // before it but delivered after — they share the same version.
        void persistLifecycleStatus(
          message.data.eventId,
          message.data.status,
          message.data.timestampMs
        ).catch((err) => console.debug('Could not persist the lifecycle transition:', err));
      }
    },
  });

  const owner: OutboxActionOwner | null = useMemo(
    () =>
      bootstrap
        ? {
            deviceSessionId: bootstrap.deviceSession.id,
            eventId: bootstrap.event.id,
            checkpointId: bootstrap.checkpoint.id,
          }
        : null,
    [bootstrap]
  );

  // Optimistic projection, computed from the real topology rather than an
  // assumption about it: the endpoints' `kind` comes from the authoritative
  // state, so a boundary crossing moves the global gauge and an internal
  // transfer does not.
  // A stored state belonging to another event describes spaces this
  // pairing does not have, so it is never read back under it.
  const snapshotMatchesPairing =
    storedSnapshot !== undefined &&
    storedSnapshot !== null &&
    bootstrap !== null &&
    storedSnapshot.eventId === bootstrap.event.id;
  const authoritativeState = snapshotMatchesPairing
    ? storedSnapshot.state
    : (bootstrap?.state ?? null);
  const lifecycle: LifecycleMarker | null =
    snapshotMatchesPairing &&
    storedSnapshot.lifecycleStatus !== undefined &&
    storedSnapshot.lifecycleAtMs !== undefined
      ? { status: storedSnapshot.lifecycleStatus, atMs: storedSnapshot.lifecycleAtMs }
      : null;
  const projection = useMemo(() => {
    if (!authoritativeState || !bootstrap) return null;
    // Only actions that can still become server truth are projected.
    //
    // A quarantined one belongs to a previous identity and will never be
    // applied under this checkpoint. A *rejected* one is a refusal the
    // server has already pronounced: adding it to the gauge would show an
    // occupancy the server has explicitly declined to record, and it would
    // stay there indefinitely since nothing retries it. Both are surfaced
    // in the reconciliation panel instead, where the operator sees the
    // counting intent without it being mixed into the main figure.
    const projectable = outboxActions.filter(
      (a) =>
        a.sendState !== 'quarantined' &&
        a.sendState !== 'rejected' &&
        a.owner?.deviceSessionId === bootstrap.deviceSession.id
    );
    return projectPendingActions(
      authoritativeState,
      { spaceAId: bootstrap.checkpoint.spaceAId, spaceBId: bootstrap.checkpoint.spaceBId },
      projectable,
      confirmedActions
    );
    // `outboxActions` is a fresh array on every live-query emission, so the
    // projection recomputes whenever the outbox actually changes.
  }, [authoritativeState, bootstrap, outboxActions, confirmedActions]);

  const displayedOccupancy = projection?.projectedEventOccupancy ?? authoritativeState?.eventOccupancy ?? 0;
  const capacity = authoritativeState?.eventCapacity ?? bootstrap?.event.capacity ?? 0;
  const remaining = capacity - displayedOccupancy;

  const spaceAOccupancy =
    authoritativeState && projection && bootstrap
      ? projectedSpaceOccupancy(authoritativeState, bootstrap.checkpoint.spaceAId, projection)
      : null;
  const spaceBOccupancy =
    authoritativeState && projection && bootstrap
      ? projectedSpaceOccupancy(authoritativeState, bootstrap.checkpoint.spaceBId, projection)
      : null;

  // The marker wins only while it is more recent than the state frame in
  // hand. A device that was offline through `begin-closing` never saw the
  // transition, and learns of it from the very next state frame instead —
  // which must not be overridden by the stale `live` marker it restored.
  const eventStatus: EventStatus = authoritativeState
    ? resolveEffectiveStatus(authoritativeState, lifecycle)
    : ((bootstrap?.event.status as EventStatus | undefined) ?? 'draft');
  // Only a `live` event accepts new taps. `closing` still lets a device
  // drain actions already queued in its outbox from before the closing
  // transition (see offline/outbox.ts flushOutbox) — this gate only
  // blocks *new* ones from being created via the buttons below.
  // A revoked session also blocks new taps: the server would refuse them
  // anyway, and letting the operator keep tapping into a dead session
  // would quietly build up counts nobody will ever receive.
  const isCountingAllowed = eventStatus === 'live' && !isSessionRevoked;

  // Handle Tap Count
  const handleTap = useCallback(
    async (direction: Direction) => {
      if (!isCountingAllowed || !owner) return;

      vibrate(25);
      const action = await enqueueCountAction(direction, owner);
      setLastAction({
        source: 'outbox',
        clientActionId: action.clientActionId,
        direction,
        clientCreatedAtMs: action.clientCreatedAtMs,
      });
    },
    [isCountingAllowed, owner]
  );

  // Handle Undo
  const handleUndo = useCallback(async () => {
    if (!lastAction || isUndoing) return;

    setIsUndoing(true);
    try {
      if (!owner) return;
      vibrate([15, 30, 15]);

      const outcome = await enqueueReversalAction(lastAction.clientActionId, owner);
      if (outcome.kind !== 'refused') {
        setConfirmedActions(await getConfirmedActions(owner));
      }
      if (outcome.kind === 'refused') {
        // The target is parked for reconciliation: its original will not be
        // sent under this identity, so a reversal would have nothing valid
        // to compensate.
        setUndoNotice(
          'Ce comptage attend une réconciliation : il ne peut pas être annulé depuis cet appareil.'
        );
      } else {
        setUndoNotice(null);
      }
      const nextLast = await getLastCountAction(owner);
      setLastAction(nextLast);
    } finally {
      setIsUndoing(false);
    }
  }, [lastAction, isUndoing, owner]);

  // Refresh the undo candidate whenever the outbox or the pairing changes,
  // so the button never offers an action that is gone or no longer ours.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getLastCountAction(owner), getConfirmedActions(owner)])
      .then(([last, confirmed]) => {
        if (cancelled) return;
        setLastAction(last);
        setConfirmedActions(confirmed);
      })
      .catch((err) => console.debug('Could not read the last undoable action:', err));
    return () => {
      cancelled = true;
    };
  }, [owner, unresolvedCount]);

  // Re-queueing notifies the sync engine on its own, so there is nothing to
  // trigger here beyond the state change itself.
  const handleRetryBlocked = useCallback(
    (clientActionId: string) => retryRejectedAction(clientActionId),
    []
  );

  // A revoked session outranks everything: nothing this device holds can
  // move until it is re-paired. Reconciliation comes next, because a
  // refused count is a standing problem rather than a transient one. Only
  // then do transport states matter — and "synced" requires an empty
  // outbox, not merely a browser that thinks it has an interface.
  const syncStatus: SyncStatus = isSessionRevoked
    ? 'revoked'
    : blockedActions.length > 0
      ? 'reconciliation'
      : !isOnline || !isConnected
        ? 'offline'
        : retryableCount > 0
          ? 'syncing'
          : 'synced';

  // Capacity Warning Color Calculation
  const capacityPercentage = capacity > 0 ? (displayedOccupancy / capacity) * 100 : 0;
  const capacityColor = useMemo(() => {
    if (displayedOccupancy > capacity && capacity > 0) return 'text-over-capacity bg-over-capacity/15 border-over-capacity/40';
    if (capacityPercentage >= 90) return 'text-danger bg-danger/15 border-danger/40';
    if (capacityPercentage >= 80) return 'text-warning bg-warning/15 border-warning/40';
    return 'text-success bg-success/15 border-success/40';
  }, [displayedOccupancy, capacity, capacityPercentage]);

  if (!bootstrap) {
    // Deliberately non-operational. When a pairing is in flight but its
    // configuration has not arrived, the counter says so rather than
    // falling back to the identity it had before — that identity no longer
    // matches the cookie this browser holds, and any tap or heartbeat made
    // under it would be attributed to the wrong device.
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground p-6">
        <div className="flex flex-col items-center gap-3 text-center max-w-sm">
          <RefreshCw className="w-8 h-8 animate-spin text-primary-accent" />
          {awaitingConfigurationFor ? (
            <>
              <span className="text-sm font-semibold text-foreground/90">
                Appairage en cours — configuration en attente
              </span>
              <span className="text-xs text-muted-foreground leading-snug">
                Cet appareil vient d’être appairé mais n’a pas encore reçu sa configuration. Le comptage
                reprendra dès qu’elle sera disponible. Les comptages déjà enregistrés sont conservés.
              </span>
            </>
          ) : (
            <span className="text-sm font-medium">Chargement du compteur...</span>
          )}
        </div>
      </div>
    );
  }

  return (
    // `flex-1`, never a height percentage: #root establishes the dynamic
    // viewport height once (`min-h-dvh`) and each route claims it here. A
    // percentage would need #root to have a definite height, which it must
    // not — a long page has to be able to grow past the viewport.
    //
    // No safe-area class either: #root already insets every route, and a
    // second inset here would be double-counted. `select-none` lives on the
    // tap surfaces below now, not on the document.
    <div className="flex-1 flex flex-col">
      {/* 1. Header: Event, Checkpoint, Connection State */}
      {/* `sticky-safe-top` replaces `top-0`: a sticky element offsets from
          the scrollport, not from #root, so at `top: 0` it would slide under
          the status bar as soon as the operator scrolls a banner state. */}
      <header className="px-4 py-3 border-b border-border bg-card/80 backdrop-blur sticky sticky-safe-top z-20">
        <div className="flex items-start justify-between gap-2">
          {/* `min-w-0` is what lets the two clamps below actually clamp: a
              flex item defaults to its content's minimum width, so a long
              door name would otherwise push the sync badge off the screen
              rather than wrap. */}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold truncate">
              {bootstrap.event.name}
            </p>
            <h1 className="text-base sm:text-xl font-black text-foreground tracking-tight leading-tight line-clamp-2">
              {bootstrap.checkpoint.name}
            </h1>
          </div>

          {/* Sync badge. Five distinct states, none of them conflating
              "the browser has an interface" with "the server has my counts".

              The pill is the shared Badge primitive, so the counter's tones
              are the same tones the admin uses. The wording stays the
              counter's own and stays upper case *in the DOM*, not by CSS:
              on the field surface these five words are the signal, and an
              operator glancing at a phone in the dark reads the shape of
              "HORS LIGNE" before they read the colour. */}
          <div className="flex flex-shrink-0 items-center gap-1.5">
            {syncStatus === 'revoked' ? (
              <Badge tone="danger">
                <Lock />
                RÉVOQUÉ
              </Badge>
            ) : syncStatus === 'reconciliation' ? (
              <Badge tone="closing">
                <AlertTriangle />À RÉGULARISER ({blockedActions.length})
              </Badge>
            ) : syncStatus === 'offline' ? (
              <Badge tone="danger">
                <WifiOff />
                HORS LIGNE{unresolvedCount > 0 ? ` (${unresolvedCount})` : ''}
              </Badge>
            ) : syncStatus === 'syncing' ? (
              <Badge tone="warning">
                <RefreshCw className="animate-spin" />
                SYNC ({retryableCount})
              </Badge>
            ) : (
              <Badge tone="success">
                <span className="size-2 shrink-0 rounded-full bg-success" />
                EN LIGNE
              </Badge>
            )}
          </div>
        </div>

        {/* Revoked / invalid device session: the supervisor pulled this
            device, so counting stops here. The local outbox is deliberately
            left untouched — deciding what happens to actions queued before
            the revocation belongs to Phase 6, and silently dropping them
            would destroy counts nobody has reconciled yet. */}
        {isSessionRevoked ? (
          <Alert tone="danger" className="mt-3">
            <AlertTriangle />
            <div className="min-w-0">
              <AlertTitle>Appareil révoqué</AlertTitle>
              <AlertDescription className="text-[11px]">
                Cette session appareil n'est plus valide. Le comptage est arrêté. Demandez un nouveau QR
                code d'appairage à un responsable.
              </AlertDescription>
            </div>
          </Alert>
        ) : null}

        {/* Counts the server refused, or that belong to a previous pairing.
            They are listed, never dropped: a field counting intent does not
            disappear to make a badge turn green. There is deliberately no
            "forget" button — discarding a real count is a supervisor
            decision with an audit trail, not a tap on a phone. */}
        {blockedActions.length > 0 ? (
          <div className="mt-3 p-3 rounded-2xl bg-closing/10 border border-closing/40 text-foreground/90 text-xs">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-closing flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="font-bold text-foreground">
                  {blockedActions.length === 1
                    ? '1 comptage n’a pas été accepté par le serveur'
                    : `${blockedActions.length} comptages n’ont pas été acceptés par le serveur`}
                  {' '}— intervention requise
                </p>
                <ul className="mt-2 space-y-1.5">
                  {blockedActions.map((action) => (
                    <li
                      key={action.clientActionId}
                      className="flex items-start justify-between gap-2 rounded-xl bg-closing/10 border border-closing/30 px-2.5 py-2"
                    >
                      <span className="min-w-0">
                        <strong className="block text-foreground">
                          {describeBlockedAction(action, bootstrap, owner)}
                        </strong>
                        <span className="text-muted-foreground text-[11px] leading-snug">
                          {describeOutboxError(action.lastErrorCode)}
                        </span>
                      </span>
                      {action.sendState === 'rejected' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleRetryBlocked(action.clientActionId)}
                          className="flex-shrink-0 border-closing/50 text-closing hover:bg-closing/15 hover:text-closing"
                        >
                          Réessayer
                        </Button>
                      ) : (
                        // Retrying a quarantined action would send it under
                        // the identity paired now, which is exactly what the
                        // quarantine exists to prevent.
                        <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-closing/90 font-bold">
                          Superviseur
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ) : null}

        {undoNotice ? (
          <Alert tone="neutral" className="mt-3">
            <CheckCircle2 />
            <span>{undoNotice}</span>
          </Alert>
        ) : null}

        {/* Explicit Offline Banner per SPEC §10.5 */}
        {!isOnline && !isSessionRevoked ? (
          <Alert tone="warning" className="mt-3">
            <AlertTriangle />
            <div className="min-w-0">
              <AlertTitle>Mode Hors Ligne Actif</AlertTitle>
              <AlertDescription className="text-[11px]">
                Le comptage continue sur cet appareil. La jauge globale peut être incomplète tant que la
                synchronisation n'est pas rétablie.
              </AlertDescription>
            </div>
          </Alert>
        ) : null}

        {eventStatus === 'draft' ? (
          <Alert tone="neutral" className="mt-3">
            <Lock />
            <span className="font-medium">
              Cet événement n'a pas encore démarré. Le comptage sera activé dès son passage en direct.
            </span>
          </Alert>
        ) : null}

        {eventStatus === 'closing' ? (
          <Alert tone="closing" className="mt-3">
            <Lock />
            <span className="font-medium">
              Événement en cours de fermeture. Nouveaux comptages désactivés.
            </span>
          </Alert>
        ) : null}
      </header>

      {/* 2. Global Occupancy Readout */}
      <section className="px-4 py-3 text-center">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-0.5">
          Jauge Globale
        </div>
        {/* Six-figure gauges exist. The pair wraps rather than widening the
            document, and the capacity drops to its own line if it must. */}
        <div className="flex flex-wrap items-baseline justify-center gap-x-2 font-mono leading-none">
          <span
            data-testid="global-occupancy"
            className="text-4xl sm:text-5xl font-black text-foreground tracking-tight"
          >
            {displayedOccupancy.toLocaleString('fr-FR')}
          </span>
          <span className="text-lg sm:text-xl font-bold text-muted-foreground">
            / {capacity.toLocaleString('fr-FR')}
          </span>
        </div>

        <div className="mt-2 flex justify-center">
          <span className={`inline-block max-w-full px-2.5 py-0.5 rounded-full border text-xs font-semibold ${capacityColor}`}>
            {remaining >= 0 ? `${remaining.toLocaleString('fr-FR')} places restantes` : `Dépassement de ${Math.abs(remaining).toLocaleString('fr-FR')}`}
          </span>
        </div>

        {/* This door's own two zones, projected the same way. An internal
            transfer leaves the global gauge above untouched while these two
            move by −1 and +1, which is the only place that is visible. An
            `external` endpoint holds no occupancy and is not shown.

            Zone names are as long as staff make them, so each badge takes
            at most half the row and truncates its name — the number, which
            is the point of the badge, always stays readable. */}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-[11px]">
          {spaceAOccupancy !== null ? (
            <span
              data-testid="space-a-occupancy"
              className="max-w-[48%] min-w-0 px-2 py-1 rounded-lg border border-border bg-card text-foreground/90 font-mono inline-flex items-baseline gap-1"
            >
              {/* Only the zone name gives way. The occupancy is the reason
                  the badge exists, so it never truncates. */}
              <span className="min-w-0 truncate">{bootstrap.checkpoint.spaceAName}</span>
              <strong className="flex-shrink-0 text-foreground">{spaceAOccupancy}</strong>
            </span>
          ) : null}
          {spaceBOccupancy !== null ? (
            <span
              data-testid="space-b-occupancy"
              className="max-w-[48%] min-w-0 px-2 py-1 rounded-lg border border-border bg-card text-foreground/90 font-mono inline-flex items-baseline gap-1"
            >
              {/* Only the zone name gives way. The occupancy is the reason
                  the badge exists, so it never truncates. */}
              <span className="min-w-0 truncate">{bootstrap.checkpoint.spaceBName}</span>
              <strong className="flex-shrink-0 text-foreground">{spaceBOccupancy}</strong>
            </span>
          ) : null}
        </div>
      </section>

      {/* 3. Primary Count Action Buttons (120–180px height per SPEC §10.3).
          The buttons grow into whatever height is left rather than being
          fixed: 120px is the floor the SPEC sets, 180px the ceiling that
          keeps a tablet from showing two slabs, and between the two they
          absorb the difference between a 568px screen and a 915px one — so
          both actions stay on screen at the small end without shrinking
          below the size a thumb needs. */}
      <main className="flex-1 px-4 pb-3 flex flex-col gap-3 justify-center">
        {/* Entry / A -> B Button */}
        {bootstrap.checkpoint.allowAToB ? (
          <button
            type="button"
            data-testid="count-a-to-b"
            disabled={!isCountingAllowed}
            onClick={() => handleTap('a_to_b')}
            className={`w-full flex-1 min-h-[120px] max-h-[180px] px-3 rounded-3xl font-black text-2xl sm:text-3xl tracking-wide flex flex-col items-center justify-center gap-1 text-center break-words shadow-2xl transition-transform active:scale-95 touch-manipulation select-none ${
              isCountingAllowed
                ? 'bg-entry text-entry-foreground hover:bg-entry/90 border-2 border-entry/60 active:bg-entry/80'
                : 'bg-muted text-muted-foreground cursor-not-allowed border border-border'
            }`}
          >
            <span>{bootstrap.checkpoint.labelAToB || 'ENTRÉE +1'}</span>
            <span className="text-xs font-medium text-entry-foreground/80 tracking-normal uppercase">
              Vers {bootstrap.checkpoint.spaceBName}
            </span>
          </button>
        ) : null}

        {/* Exit / B -> A Button */}
        {bootstrap.checkpoint.allowBToA ? (
          <button
            type="button"
            data-testid="count-b-to-a"
            disabled={!isCountingAllowed}
            onClick={() => handleTap('b_to_a')}
            className={`w-full flex-1 min-h-[120px] max-h-[180px] px-3 rounded-3xl font-black text-2xl sm:text-3xl tracking-wide flex flex-col items-center justify-center gap-1 text-center break-words shadow-2xl transition-transform active:scale-95 touch-manipulation select-none ${
              isCountingAllowed
                ? 'bg-exit text-exit-foreground hover:bg-exit/90 border-2 border-exit/60 active:bg-exit/80'
                : 'bg-muted text-muted-foreground cursor-not-allowed border border-border'
            }`}
          >
            <span>{bootstrap.checkpoint.labelBToA || 'SORTIE −1'}</span>
            <span className="text-xs font-medium text-exit-foreground/80 tracking-normal uppercase">
              Vers {bootstrap.checkpoint.spaceAName}
            </span>
          </button>
        ) : null}
      </main>

      {/* 4. Footer: Last Action Feedback & Undo. The home-indicator inset is
          #root's job, not this element's — see the safe-area contract in
          styles/index.css. */}
      <footer className="px-4 py-3 border-t border-border bg-card/80">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1 text-xs text-foreground/90 flex items-center gap-2">
            {lastAction ? (
              <>
                <span className="w-2 h-2 rounded-full bg-primary-accent animate-ping flex-shrink-0"></span>
                <span className="min-w-0 break-words">
                  Dernière saisie :{' '}
                  <strong className="text-foreground">
                    {lastAction.direction === 'a_to_b'
                      ? bootstrap.checkpoint.labelAToB
                      : bootstrap.checkpoint.labelBToA}
                  </strong>
                  {lastAction.source === 'confirmed' ? (
                    <span className="text-muted-foreground"> (synchronisée)</span>
                  ) : null}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Aucune saisie récente</span>
            )}
          </div>

          {lastAction && isCountingAllowed ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={isUndoing}
              onClick={handleUndo}
              className="flex-shrink-0 text-warning active:scale-95"
            >
              <RotateCcw className={isUndoing ? 'animate-spin' : undefined} />
              ANNULER
            </Button>
          ) : null}
        </div>
      </footer>
    </div>
  );
};
