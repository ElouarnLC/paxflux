import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';
import { EventModel, PreflightResponse } from '@paxflux/shared';
import { PlayCircle, Lock, XCircle, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';

interface LifecycleControlsProps {
  event: EventModel;
  onChanged: () => void;
}

/**
 * Minimum lifecycle surface for Phase 3: draft -> live -> closing -> closed.
 * Each transition calls the corresponding server endpoint directly — the
 * server is the sole source of truth for whether a transition is valid
 * (see apps/server/src/domain/events.ts); this component only decides
 * which single action makes sense to offer for the current status and
 * asks for confirmation before calling it.
 */
export const LifecycleControls: React.FC<LifecycleControlsProps> = ({ event, onChanged }) => {
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [loadingPreflight, setLoadingPreflight] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshPreflight = useCallback(async () => {
    if (event.status !== 'draft') return;
    setLoadingPreflight(true);
    try {
      const res = await apiFetch<PreflightResponse>(`/api/v1/events/${event.id}/preflight`);
      setPreflight(res);
    } catch {
      setPreflight(null);
    } finally {
      setLoadingPreflight(false);
    }
  }, [event.id, event.status]);

  useEffect(() => {
    refreshPreflight();
  }, [refreshPreflight]);

  const runTransition = useCallback(
    async (path: string, confirmMessage: string) => {
      if (!window.confirm(confirmMessage)) return;
      setActionLoading(true);
      setActionError(null);
      try {
        await apiFetch(`/api/v1/events/${event.id}/${path}`, { method: 'POST' });
        onChanged();
      } catch (err: any) {
        setActionError(err?.detail || 'Une erreur est survenue.');
      } finally {
        setActionLoading(false);
      }
    },
    [event.id, onChanged]
  );

  const errorBanner = actionError ? (
    <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/30 text-rose-200 text-xs flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>{actionError}</span>
    </div>
  ) : null;

  if (event.status === 'draft') {
    return (
      <div className="space-y-3">
        {loadingPreflight ? (
          <p className="text-xs text-slate-400 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Vérification du préflight…
          </p>
        ) : preflight && !preflight.ready ? (
          <div className="p-3 rounded-xl bg-amber-950/60 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{preflight.error?.message || "Cet événement n'est pas prêt à démarrer."}</span>
          </div>
        ) : preflight?.ready ? (
          <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-500/30 text-emerald-200 text-xs flex items-start gap-2">
            <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Topologie valide. Prêt à démarrer.</span>
          </div>
        ) : null}

        {errorBanner}

        <button
          type="button"
          disabled={actionLoading || !preflight?.ready}
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
    return (
      <div className="space-y-3">
        {errorBanner}
        <button
          type="button"
          disabled={actionLoading}
          onClick={() => runTransition('close', "Clôturer définitivement l'événement ?")}
          className="w-full py-2.5 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-bold text-xs flex items-center justify-center gap-2 transition-all"
        >
          {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
          Clôturer l'événement
        </button>
      </div>
    );
  }

  return <p className="text-xs text-slate-500">Aucune action de cycle de vie disponible pour cet état ({event.status}).</p>;
};
