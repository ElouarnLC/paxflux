import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { localDb } from '../offline/db.js';
import {
  enqueueCountAction,
  enqueueReversalAction,
  getLastCountAction,
  calculatePendingDelta,
  triggerFlush,
} from '../offline/outbox.js';
import { useSSE } from '../sse/useSSE.js';
import { apiFetch } from '../api/client.js';
import {
  DeviceBootstrapResponse,
  CompactEventState,
  Direction,
  OutboxActionRecord,
} from '@paxflux/shared';
import {
  Wifi,
  WifiOff,
  RefreshCw,
  RotateCcw,
  AlertTriangle,
  Lock,
  Smartphone,
  ChevronRight,
} from 'lucide-react';

export const CounterView: React.FC = () => {
  const [bootstrap, setBootstrap] = useState<DeviceBootstrapResponse | null>(null);
  const [serverState, setServerState] = useState<CompactEventState | null>(null);
  const [lastAction, setLastAction] = useState<OutboxActionRecord | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Live Dexie query for pending outbox actions count
  const pendingCount = useLiveQuery(() => localDb.outbox_actions.count(), []) ?? 0;

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
    let wakeLock: any = null;
    async function requestWakeLock() {
      if ('wakeLock' in navigator) {
        try {
          wakeLock = await (navigator as any).wakeLock.request('screen');
        } catch {
          // ignore
        }
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
      if (wakeLock) wakeLock.release().catch(() => {});
    };
  }, []);

  // Load bootstrap config from cache or server
  useEffect(() => {
    async function init() {
      // Check cache first
      const cached = await localDb.device_cache.get('bootstrap_config');
      if (cached?.bootstrap) {
        setBootstrap(cached.bootstrap);
        setServerState(cached.lastState || cached.bootstrap.state);
      }

      // Refresh from server if online
      if (navigator.onLine) {
        try {
          const fresh = await apiFetch<DeviceBootstrapResponse>('/api/v1/device/bootstrap');
          setBootstrap(fresh);
          setServerState(fresh.state);
          await localDb.device_cache.put({
            key: 'bootstrap_config',
            bootstrap: fresh,
            lastState: fresh.state,
            updatedAtMs: Date.now(),
          });
        } catch (err) {
          console.debug('Failed to refresh bootstrap from server:', err);
        }
      }

      // Fetch last action for undo
      const last = await getLastCountAction();
      setLastAction(last);
    }

    init();
  }, []);

  // SSE Stream for real-time state updates
  const { isConnected } = useSSE({
    url: '/api/v1/device/stream',
    enabled: isOnline,
    onState: (state) => {
      setServerState(state);
      localDb.device_cache.put({
        key: 'last_server_state',
        lastState: state,
        updatedAtMs: Date.now(),
      });
    },
  });

  // Calculate optimistic occupancy
  const [pendingDelta, setPendingDelta] = useState(0);

  useEffect(() => {
    async function updateDelta() {
      if (!bootstrap) return;
      const isSpaceBLeaf = true; // In our topology, spaceB is typically the counted internal leaf
      const d = await calculatePendingDelta(bootstrap.checkpoint.spaceAId, bootstrap.checkpoint.spaceBId, isSpaceBLeaf);
      setPendingDelta(d);
    }
    updateDelta();
  }, [bootstrap, pendingCount]);

  const baseOccupancy = serverState?.eventOccupancy ?? bootstrap?.state.eventOccupancy ?? 0;
  const displayedOccupancy = baseOccupancy + pendingDelta;
  const capacity = serverState?.eventCapacity ?? bootstrap?.event.capacity ?? 0;
  const remaining = capacity - displayedOccupancy;

  const eventStatus = serverState?.eventStatus ?? bootstrap?.event.status ?? 'draft';
  const isCountingAllowed = eventStatus === 'live' || eventStatus === 'closing';

  // Handle Tap Count
  const handleTap = useCallback(
    async (direction: Direction) => {
      if (!isCountingAllowed) return;

      // Haptic feedback (SPEC §10.4)
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        try {
          navigator.vibrate(25);
        } catch {
          // ignore
        }
      }

      const action = await enqueueCountAction(direction);
      setLastAction(action);
    },
    [isCountingAllowed]
  );

  // Handle Undo
  const handleUndo = useCallback(async () => {
    if (!lastAction || isUndoing) return;

    setIsUndoing(true);
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        try {
          navigator.vibrate([15, 30, 15]);
        } catch {
          // ignore
        }
      }

      await enqueueReversalAction(lastAction.clientActionId);
      const nextLast = await getLastCountAction();
      setLastAction(nextLast);
    } finally {
      setIsUndoing(false);
    }
  }, [lastAction, isUndoing]);

  // Capacity Warning Color Calculation
  const capacityPercentage = capacity > 0 ? (displayedOccupancy / capacity) * 100 : 0;
  const capacityColor = useMemo(() => {
    if (displayedOccupancy > capacity && capacity > 0) return 'text-purple-400 bg-purple-950/60 border-purple-500/40';
    if (capacityPercentage >= 90) return 'text-rose-400 bg-rose-950/60 border-rose-500/40';
    if (capacityPercentage >= 80) return 'text-amber-400 bg-amber-950/60 border-amber-500/40';
    return 'text-emerald-400 bg-emerald-950/60 border-emerald-500/40';
  }, [displayedOccupancy, capacity, capacityPercentage]);

  if (!bootstrap) {
    return (
      <div className="min-h-full flex items-center justify-center bg-slate-950 text-slate-400">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
          <span className="text-sm font-medium">Chargement du compteur...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full flex flex-col bg-slate-950 text-slate-100 select-none pb-safe">
      {/* 1. Header: Event, Checkpoint, Connection State */}
      <header className="px-5 pt-4 pb-3 border-b border-slate-900 bg-slate-950/80 backdrop-blur sticky top-0 z-20">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-slate-400 font-semibold">
              {bootstrap.event.name}
            </p>
            <h1 className="text-xl font-black text-white tracking-tight">
              {bootstrap.checkpoint.name}
            </h1>
          </div>

          {/* Connection / Sync Badge */}
          <div className="flex items-center gap-1.5">
            {isOnline && isConnected && pendingCount === 0 ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-950 border border-emerald-500/40 text-emerald-300">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                EN LIGNE
              </span>
            ) : isOnline && pendingCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-950 border border-amber-500/40 text-amber-300 animate-pulse">
                <RefreshCw className="w-3 h-3 animate-spin" />
                SYNC ({pendingCount})
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-950 border border-rose-500/40 text-rose-300">
                <WifiOff className="w-3 h-3" />
                HORS LIGNE
              </span>
            )}
          </div>
        </div>

        {/* Explicit Offline Banner per SPEC §10.5 */}
        {!isOnline ? (
          <div className="mt-3 p-3 rounded-2xl bg-amber-950/80 border border-amber-500/50 text-amber-200 text-xs flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-amber-100">Mode Hors Ligne Actif</p>
              <p className="text-amber-200/90 text-[11px] mt-0.5 leading-snug">
                Le comptage continue sur cet appareil. La jauge globale peut être incomplète tant que la synchronisation n'est pas rétablie.
              </p>
            </div>
          </div>
        ) : null}

        {eventStatus === 'closing' ? (
          <div className="mt-3 p-2.5 rounded-xl bg-orange-950/80 border border-orange-500/40 text-orange-200 text-xs flex items-center gap-2">
            <Lock className="w-4 h-4 text-orange-400 flex-shrink-0" />
            <span className="font-medium">Événement en cours de fermeture. Nouveaux comptages désactivés.</span>
          </div>
        ) : null}
      </header>

      {/* 2. Global Occupancy Readout */}
      <section className="px-5 py-4 text-center">
        <div className="text-xs uppercase tracking-widest text-slate-400 font-bold mb-1">
          Jauge Globale
        </div>
        <div className="flex items-baseline justify-center gap-2 font-mono">
          <span className="text-5xl font-black text-white tracking-tight">
            {displayedOccupancy.toLocaleString('fr-FR')}
          </span>
          <span className="text-xl font-bold text-slate-400">
            / {capacity.toLocaleString('fr-FR')}
          </span>
        </div>

        <div className="mt-2 inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border transition-colors duration-300">
          <span className={`px-2.5 py-0.5 rounded-full ${capacityColor}`}>
            {remaining >= 0 ? `${remaining.toLocaleString('fr-FR')} places restantes` : `Dépassement de ${Math.abs(remaining).toLocaleString('fr-FR')}`}
          </span>
        </div>
      </section>

      {/* 3. Primary Count Action Buttons (120–180px height per SPEC §10.3) */}
      <main className="flex-1 px-5 flex flex-col gap-4 justify-center">
        {/* Entry / A -> B Button */}
        {bootstrap.checkpoint.allowAToB ? (
          <button
            type="button"
            disabled={!isCountingAllowed}
            onClick={() => handleTap('a_to_b')}
            className={`w-full h-36 md:h-44 rounded-3xl font-black text-3xl tracking-wide flex flex-col items-center justify-center gap-1 shadow-2xl transition-transform active:scale-95 touch-manipulation select-none ${
              isCountingAllowed
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/60 border-2 border-emerald-400/40 active:bg-emerald-700'
                : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
            }`}
          >
            <span>{bootstrap.checkpoint.labelAToB || 'ENTRÉE +1'}</span>
            <span className="text-xs font-medium text-emerald-200/80 tracking-normal uppercase">
              Vers {bootstrap.checkpoint.spaceBName}
            </span>
          </button>
        ) : null}

        {/* Exit / B -> A Button */}
        {bootstrap.checkpoint.allowBToA ? (
          <button
            type="button"
            disabled={!isCountingAllowed}
            onClick={() => handleTap('b_to_a')}
            className={`w-full h-36 md:h-44 rounded-3xl font-black text-3xl tracking-wide flex flex-col items-center justify-center gap-1 shadow-2xl transition-transform active:scale-95 touch-manipulation select-none ${
              isCountingAllowed
                ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-950/60 border-2 border-rose-400/40 active:bg-rose-700'
                : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
            }`}
          >
            <span>{bootstrap.checkpoint.labelBToA || 'SORTIE −1'}</span>
            <span className="text-xs font-medium text-rose-200/80 tracking-normal uppercase">
              Vers {bootstrap.checkpoint.spaceAName}
            </span>
          </button>
        ) : null}
      </main>

      {/* 4. Footer: Last Action Feedback & Undo */}
      <footer className="px-5 py-4 border-t border-slate-900 bg-slate-950/90 flex items-center justify-between">
        <div className="text-xs text-slate-300 flex items-center gap-2">
          {lastAction ? (
            <>
              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-ping"></span>
              <span>
                Dernière saisie :{' '}
                <strong className="text-white">
                  {lastAction.type === 'count'
                    ? lastAction.direction === 'a_to_b'
                      ? bootstrap.checkpoint.labelAToB
                      : bootstrap.checkpoint.labelBToA
                    : 'Annulation'}
                </strong>
              </span>
            </>
          ) : (
            <span className="text-slate-400">Aucune saisie récente</span>
          )}
        </div>

        {lastAction && isCountingAllowed ? (
          <button
            type="button"
            disabled={isUndoing}
            onClick={handleUndo}
            className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-900 border border-slate-700 text-amber-300 font-bold text-xs flex items-center gap-1.5 shadow-lg active:scale-95 transition-all"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${isUndoing ? 'animate-spin' : ''}`} />
            ANNULER
          </button>
        ) : null}
      </footer>
    </div>
  );
};
