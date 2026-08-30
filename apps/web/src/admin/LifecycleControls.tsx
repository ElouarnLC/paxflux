import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import { EventDetailResponse, EventModel, ProblemDetails, PreflightResponse } from '@paxflux/shared';
import {
  PlayCircle,
  Lock,
  XCircle,
  AlertTriangle,
  CheckCircle,
  Loader2,
  RefreshCw,
  Wifi,
  WifiOff,
  RotateCcw,
  Archive,
} from 'lucide-react';

type DeviceRow = EventDetailResponse['devices'][number];

interface LifecycleControlsProps {
  event: EventModel;
  onChanged: () => void;
}

function errorDetail(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'detail' in err) {
    return String((err as ProblemDetails).detail);
  }
  return fallback;
}

type PreflightState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PreflightResponse }
  | { kind: 'error'; detail: string };

type DevicesState =
  | { kind: 'loading' }
  | { kind: 'ready'; devices: DeviceRow[] }
  | { kind: 'error'; detail: string };

/**
 * Lifecycle surface for Phase 3: draft -> live -> closing -> closed ->
 * archived, plus the admin-only closed -> live reopen. Each transition
 * calls the corresponding server endpoint directly — the server is the
 * sole source of truth for whether a transition is valid (see
 * apps/server/src/domain/events.ts) — this component only decides which
 * actions make sense to offer for the current status and asks for
 * confirmation (a reason too, for the two audited actions) before calling
 * them.
 */
export const LifecycleControls: React.FC<LifecycleControlsProps> = ({ event, onChanged }) => {
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';

  const [preflight, setPreflight] = useState<PreflightState>({ kind: 'loading' });
  const [devicesState, setDevicesState] = useState<DevicesState>({ kind: 'loading' });
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshPreflight = useCallback(async () => {
    if (event.status !== 'draft') return;
    setPreflight({ kind: 'loading' });
    try {
      const res = await apiFetch<PreflightResponse>(`/api/v1/events/${event.id}/preflight`);
      setPreflight({ kind: 'ready', data: res });
    } catch (err) {
      setPreflight({ kind: 'error', detail: errorDetail(err, 'Impossible de vérifier le préflight.') });
    }
  }, [event.id, event.status]);

  const refreshDevices = useCallback(async () => {
    if (event.status !== 'closing') return;
    setDevicesState({ kind: 'loading' });
    try {
      const res = await apiFetch<DeviceRow[]>(`/api/v1/events/${event.id}/devices`);
      setDevicesState({ kind: 'ready', devices: res });
    } catch (err) {
      setDevicesState({ kind: 'error', detail: errorDetail(err, 'Impossible de charger la liste des appareils.') });
    }
  }, [event.id, event.status]);

  useEffect(() => {
    refreshPreflight();
  }, [refreshPreflight]);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  const runTransition = useCallback(
    async (path: string, confirmMessage: string, body?: Record<string, unknown>) => {
      if (!window.confirm(confirmMessage)) return;
      setActionLoading(true);
      setActionError(null);
      try {
        await apiFetch(`/api/v1/events/${event.id}/${path}`, {
          method: 'POST',
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        onChanged();
      } catch (err) {
        setActionError(errorDetail(err, 'Une erreur est survenue.'));
      } finally {
        setActionLoading(false);
      }
    },
    [event.id, onChanged]
  );

  const promptForReason = (title: string): string | null => {
    const reason = window.prompt(title);
    if (reason === null) return null;
    if (reason.trim().length < 3) {
      setActionError("Un motif d'au moins 3 caractères est requis.");
      return null;
    }
    return reason.trim();
  };

  const errorBanner = actionError ? (
    <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/30 text-rose-200 text-xs flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>{actionError}</span>
    </div>
  ) : null;

  if (event.status === 'draft') {
    return (
      <div className="space-y-3">
        {preflight.kind === 'loading' ? (
          <p className="text-xs text-slate-400 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Vérification du préflight…
          </p>
        ) : preflight.kind === 'error' ? (
          <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/30 text-rose-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p>{preflight.detail}</p>
              <button
                type="button"
                onClick={refreshPreflight}
                className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-900/60 hover:bg-rose-900 text-rose-100 font-semibold"
              >
                <RefreshCw className="w-3 h-3" /> Réessayer
              </button>
            </div>
          </div>
        ) : !preflight.data.ready ? (
          <div className="p-3 rounded-xl bg-amber-950/60 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{preflight.data.error?.message || "Cet événement n'est pas prêt à démarrer."}</span>
          </div>
        ) : (
          <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-500/30 text-emerald-200 text-xs flex items-start gap-2">
            <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Topologie valide. Prêt à démarrer.</span>
          </div>
        )}

        {errorBanner}

        <button
          type="button"
          disabled={actionLoading || preflight.kind !== 'ready' || !preflight.data.ready}
          onClick={() => runTransition('start', "Démarrer l'événement et le passer en direct ?")}
          className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-bold text-xs flex items-center justify-center gap-2 transition-all"
        >
          {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
          Démarrer l'événement
        </button>
      </div>
    );
  }

  if (event.status === 'live') {
    return (
      <div className="space-y-3">
        {errorBanner}
        <button
          type="button"
          disabled={actionLoading}
          onClick={() =>
            runTransition(
              'begin-closing',
              "Débuter la fermeture ? Les compteurs sur le terrain n'accepteront plus de nouveaux comptages."
            )
          }
          className="w-full py-2.5 px-4 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-bold text-xs flex items-center justify-center gap-2 transition-all"
        >
          {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
          Débuter la fermeture
        </button>
      </div>
    );
  }

  if (event.status === 'closing') {
    const allSynced = devicesState.kind === 'ready' && devicesState.devices.every((d) => d.isOnline && d.lastPendingCount === 0);

    return (
      <div className="space-y-3">
        {errorBanner}

        {devicesState.kind === 'loading' ? (
          <p className="text-xs text-slate-400 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement des appareils…
          </p>
        ) : devicesState.kind === 'error' ? (
          <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/30 text-rose-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p>{devicesState.detail}</p>
              <button
                type="button"
                onClick={refreshDevices}
                className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-900/60 hover:bg-rose-900 text-rose-100 font-semibold"
              >
                <RefreshCw className="w-3 h-3" /> Réessayer
              </button>
            </div>
          </div>
        ) : devicesState.devices.length === 0 ? (
          <p className="text-xs text-slate-500">Aucun appareil actif pour cet événement.</p>
        ) : (
          <div className="space-y-1.5">
            {devicesState.devices.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between text-xs p-2.5 rounded-xl bg-slate-950 border border-slate-800"
              >
                <span className="font-semibold text-slate-200">
                  {d.checkpointName} — {d.label}
                </span>
                <span className="flex items-center gap-2.5">
                  {d.isOnline ? (
                    <span className="flex items-center gap-1 text-emerald-400 font-semibold">
                      <Wifi className="w-3.5 h-3.5" /> En ligne
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-rose-400 font-semibold">
                      <WifiOff className="w-3.5 h-3.5" /> Hors ligne
                    </span>
                  )}
                  {d.lastPendingCount > 0 ? (
                    <span className="text-amber-400 font-semibold">{d.lastPendingCount} en attente</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}

        {devicesState.kind === 'ready' && !allSynced ? (
          <p className="text-[11px] text-amber-300/90">
            La fermeture normale nécessite que tous les appareils actifs soient hors ligne et synchronisés (0 en attente).
          </p>
        ) : null}

        <button
          type="button"
          disabled={actionLoading || !allSynced}
          onClick={() => runTransition('close', "Clôturer l'événement ? Tous les appareils actifs sont synchronisés.")}
          className="w-full py-2.5 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-bold text-xs flex items-center justify-center gap-2 transition-all"
        >
          {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
          Clôturer l'événement
        </button>

        {isAdmin ? (
          <button
            type="button"
            disabled={actionLoading}
            onClick={() => {
              const reason = promptForReason(
                'Fermeture forcée : motif obligatoire (appareils non synchronisés seront ignorés).'
              );
              if (!reason) return;
              runTransition(
                'force-close',
                `Confirmer la fermeture FORCÉE malgré des appareils potentiellement non synchronisés ?\n\nMotif : "${reason}"`,
                { reason }
              );
            }}
            className="w-full py-2 px-4 rounded-xl bg-transparent hover:bg-rose-950/40 border border-rose-500/40 disabled:opacity-50 disabled:cursor-not-allowed text-rose-300 font-bold text-[11px] flex items-center justify-center gap-2 transition-all"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            Fermeture forcée (admin)
          </button>
        ) : null}
      </div>
    );
  }

  if (event.status === 'closed') {
    if (!isAdmin) {
      return <p className="text-xs text-slate-500">Événement clos. Seul un administrateur peut le réouvrir ou l'archiver.</p>;
    }

    return (
      <div className="space-y-3">
        {errorBanner}
        <button
          type="button"
          disabled={actionLoading}
          onClick={() => {
            const reason = promptForReason("Réouverture : motif obligatoire (tracé dans l'audit).");
            if (!reason) return;
            runTransition('reopen', `Réouvrir l'événement clos ?\n\nMotif : "${reason}"`, { reason });
          }}
          className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-bold text-xs flex items-center justify-center gap-2 transition-all"
        >
          {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          Réouvrir l'événement
        </button>
        <button
          type="button"
          disabled={actionLoading}
          onClick={() => runTransition('archive', "Archiver l'événement ? Cette action est terminale.")}
          className="w-full py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-slate-200 font-bold text-xs flex items-center justify-center gap-2 transition-all"
        >
          {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
          Archiver l'événement
        </button>
      </div>
    );
  }

  if (event.status === 'archived') {
    return <p className="text-xs text-slate-500">Événement archivé — lecture seule.</p>;
  }

  return <p className="text-xs text-slate-500">Aucune action de cycle de vie disponible pour cet état ({event.status}).</p>;
};
