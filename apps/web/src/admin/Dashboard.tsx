import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { useSSE } from '../sse/useSSE.js';
import { LifecycleControls } from './LifecycleControls.js';
import {
  EventDetailResponse,
  EventModel,
  SyncQuality,
  CompactEventState,
} from '@paxflux/shared';
import {
  Users,
  TrendingUp,
  TrendingDown,
  Activity,
  ShieldCheck,
  AlertTriangle,
  Radio,
  Sliders,
  QrCode,
  Download,
  Lock,
  Plus,
  RefreshCw,
  Clock,
  Smartphone,
  ExternalLink,
} from 'lucide-react';

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [eventsList, setEventsList] = useState<EventModel[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventDetail, setEventDetail] = useState<EventDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Load events list
  useEffect(() => {
    async function fetchEvents() {
      try {
        const list = await apiFetch<EventModel[]>('/api/v1/events');
        setEventsList(list);
        if (list.length > 0 && !selectedEventId) {
          // An explicit ?event= (e.g. the wizard just created a draft)
          // always wins — otherwise a live event elsewhere would hide it.
          const requestedId = searchParams.get('event');
          const requested = requestedId ? list.find((e) => e.id === requestedId) : undefined;
          const live = requested || list.find((e) => e.status === 'live' || e.status === 'closing') || list[0];
          setSelectedEventId(live.id);
        }
      } catch {
        navigate('/login');
      } finally {
        setLoading(false);
      }
    }
    fetchEvents();
  }, [navigate, selectedEventId, searchParams]);

  // Load selected event details
  const refreshDetails = async () => {
    if (!selectedEventId) return;
    try {
      const details = await apiFetch<EventDetailResponse>(`/api/v1/events/${selectedEventId}/state`);
      setEventDetail(details);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (selectedEventId) {
      refreshDetails();
    }
  }, [selectedEventId]);

  // SSE Stream for Realtime Live Updates
  useSSE({
    url: selectedEventId ? `/api/v1/events/${selectedEventId}/stream` : '',
    enabled: !!selectedEventId,
    onState: (state: CompactEventState) => {
      setEventDetail((prev: any) => {
        if (!prev) return prev;
        const updatedSpaces: Record<string, number> = {};
        for (const s of state.spaces) {
          updatedSpaces[s.id] = s.occupancy;
        }
        return {
          ...prev,
          occupancy: {
            global: state.eventOccupancy,
            spaces: updatedSpaces,
          },
          event: {
            ...prev.event,
            status: state.eventStatus as any,
            capacity: state.eventCapacity,
            version: state.version,
          },
        };
      });
    },
  });

  if (loading) {
    return (
      <div className="min-h-full flex items-center justify-center bg-slate-950 text-slate-400">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
      </div>
    );
  }

  if (eventsList.length === 0) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center p-6 text-center bg-slate-950 text-slate-100">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl">
          <Users className="w-12 h-12 text-indigo-400 mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2">Aucun événement configuré</h2>
          <p className="text-slate-400 text-sm mb-6">
            Créez votre premier événement pour commencer le comptage de jauge en direct.
          </p>
          <Link
            to="/admin/events/new"
            className="inline-flex items-center gap-2 min-h-11 px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-bold text-sm text-white shadow-lg transition-all"
          >
            <Plus className="w-4 h-4" />
            Créer un événement
          </Link>
        </div>
      </div>
    );
  }

  const currentEvent = eventDetail?.event || eventsList.find((e) => e.id === selectedEventId);
  const globalOccupancy = eventDetail?.occupancy.global || 0;
  const capacity = currentEvent?.capacity || 0;
  const capacityPercentage = capacity > 0 ? (globalOccupancy / capacity) * 100 : 0;
  const remaining = capacity - globalOccupancy;

  const syncQuality: SyncQuality = eventDetail?.syncQuality || 'reliable';

  return (
    <div className="min-h-full bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Navbar */}
      {/* The brand, the shortcut to Système and the event control used to
          share one non-wrapping row. On a phone that row was simply wider
          than the screen, taking `Nouvel événement` off it. It now folds:
          brand and Système on the first line, the selector and the create
          action on the second, back to a single row from `sm` up. */}
      <header className="px-4 sm:px-6 py-3 border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-black text-lg sm:text-xl tracking-tight text-white">PaxFlux</span>
          <span className="text-xs px-2.5 py-0.5 rounded-full bg-indigo-950 border border-indigo-500/30 text-indigo-300 font-medium">
            Supervision
          </span>
        </div>

        <Link
          to="/admin/system"
          className="ml-auto inline-flex items-center min-h-11 px-2 text-xs font-medium text-slate-400 hover:text-white transition-colors"
        >
          Système
        </Link>

        <div className="w-full sm:w-auto flex items-center gap-2 min-w-0">
          {/* `min-w-0` is the whole reason this selector can be narrow: a
              form control's default minimum width is its content, so an
              event named at full length would otherwise stretch the header
              past the viewport rather than shrink. */}
          <select
            value={selectedEventId || ''}
            onChange={(e) => setSelectedEventId(e.target.value)}
            className="flex-1 sm:flex-none sm:max-w-64 min-w-0 min-h-11 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-base md:text-xs font-semibold text-white"
          >
            {eventsList.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name} ({ev.status.toUpperCase()})
              </option>
            ))}
          </select>

          <Link
            to="/admin/events/new"
            className="flex-shrink-0 flex items-center gap-1 min-h-11 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all shadow-md"
          >
            <Plus className="w-3.5 h-3.5" />
            Nouvel événement
          </Link>
        </div>
      </header>

      {/* Main Dashboard Content */}
      <main className="flex-1 p-4 sm:p-6 max-w-7xl mx-auto w-full space-y-4 sm:space-y-6">
        {/* 1. Global Metrics & Sync Health Card */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
          {/* Main Occupancy Card */}
          <div className="md:col-span-2 bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xl flex flex-col justify-between">
            <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
              <div className="min-w-0">
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">Jauge en Direct</h2>
                <p
                  data-testid="dashboard-event-name"
                  className="text-xl sm:text-2xl font-black text-white mt-1 break-words"
                >
                  {currentEvent?.name}
                </p>
              </div>

              {/* Status Badge */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border ${
                  currentEvent?.status === 'live'
                    ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-300'
                    : currentEvent?.status === 'closing'
                    ? 'bg-orange-950/80 border-orange-500/40 text-orange-300'
                    : 'bg-slate-800 border-slate-700 text-slate-300'
                }`}>
                  <Radio className={`w-3.5 h-3.5 ${currentEvent?.status === 'live' ? 'animate-pulse text-emerald-400' : ''}`} />
                  {currentEvent?.status}
                </span>
              </div>
            </div>

            {/* Occupancy, capacity and percentage wrap instead of forcing
                the card wider: a six-figure gauge next to a six-figure
                capacity does not fit on one line at 320px. */}
            <div className="my-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono">
              <span className="text-4xl sm:text-6xl font-black text-white tracking-tight">
                {globalOccupancy.toLocaleString('fr-FR')}
              </span>
              <span className="text-xl sm:text-2xl font-bold text-slate-400">
                / {capacity.toLocaleString('fr-FR')}
              </span>
              <span className="text-sm font-semibold text-slate-400 font-sans ml-auto">
                {capacityPercentage.toFixed(1)} %
              </span>
            </div>

            {/* Progress Bar */}
            <div className="w-full h-3.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800 relative mb-3">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  globalOccupancy > capacity
                    ? 'bg-purple-500'
                    : capacityPercentage >= 90
                    ? 'bg-rose-500'
                    : capacityPercentage >= 80
                    ? 'bg-amber-500'
                    : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(capacityPercentage, 100)}%` }}
              ></div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs font-semibold">
              <span className="text-slate-400">
                {remaining >= 0 ? `${remaining.toLocaleString('fr-FR')} places disponibles` : `Dépassement de ${Math.abs(remaining).toLocaleString('fr-FR')}`}
              </span>
              <span className="text-slate-400">Version du journal : #{currentEvent?.version}</span>
            </div>
          </div>

          {/* Sync Health Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xl flex flex-col justify-between">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-2">Qualité de Synchronisation</h2>
              <div className="mt-4 p-4 rounded-2xl border flex items-start gap-3 bg-slate-950/60">
                {syncQuality === 'reliable' ? (
                  <>
                    <ShieldCheck className="w-6 h-6 text-emerald-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-emerald-300 text-sm">Synchronisation Fiable</p>
                      <p className="text-slate-400 text-xs mt-1">Tous les appareils sont connectés et à jour.</p>
                    </div>
                  </>
                ) : syncQuality === 'degraded' ? (
                  <>
                    <AlertTriangle className="w-6 h-6 text-amber-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-amber-300 text-sm">Synchronisation Dégradée</p>
                      <p className="text-slate-400 text-xs mt-1">Un ou plusieurs appareils ont des actions en attente.</p>
                    </div>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-6 h-6 text-rose-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-rose-300 text-sm">Non Garantie</p>
                      <p className="text-slate-400 text-xs mt-1">Plusieurs appareils déconnectés. Jauge globale incertaine.</p>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="mt-6 flex flex-col gap-2">
              <Link
                to={`/admin/events/${selectedEventId}/devices`}
                className="w-full min-h-11 py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs flex items-center justify-between gap-2 transition-all"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <QrCode className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                  Gérer les appareils & QR codes
                </span>
                <ExternalLink className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
              </Link>

              <Link
                to={`/admin/events/${selectedEventId}/analytics`}
                className="w-full min-h-11 py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs flex items-center justify-between gap-2 transition-all"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Activity className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  Statistiques détaillées
                </span>
                <ExternalLink className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
              </Link>
            </div>
          </div>
        </div>

        {/* 1b. Lifecycle Controls */}
        {currentEvent ? (
          <section className="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xl">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4">Cycle de vie de l'événement</h3>
            <LifecycleControls event={currentEvent} onChanged={refreshDetails} />
          </section>
        ) : null}

        {/* 2. Space Breakdown */}
        <section className="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xl">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <h3 className="text-base font-bold text-white">Répartition par Zone</h3>
            <span className="text-xs text-slate-400">Total zones : {eventDetail?.spaces.length || 0}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {eventDetail?.spaces
              .filter((s: any) => s.kind !== 'external')
              .map((sp: any) => {
                const occ = eventDetail.occupancy.spaces[sp.id] || 0;
                const spCap = sp.capacity || 0;
                const pct = spCap > 0 ? (occ / spCap) * 100 : 0;

                return (
                  <div
                    key={sp.id}
                    className="p-4 rounded-2xl bg-slate-950 border border-slate-800 flex flex-col justify-between"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="font-bold text-white text-sm break-words">{sp.name}</h4>
                        <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                          {sp.kind === 'leaf' ? 'Zone Simple' : 'Agrégat'}
                        </span>
                      </div>
                      <span className="text-lg font-mono font-bold text-white flex-shrink-0">
                        {occ} {spCap > 0 ? `/ ${spCap}` : ''}
                      </span>
                    </div>

                    {spCap > 0 ? (
                      <div className="mt-3">
                        <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${pct >= 90 ? 'bg-rose-500' : 'bg-emerald-500'}`}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          ></div>
                        </div>
                        <span className="text-[10px] text-slate-400 font-semibold mt-1 block text-right">
                          {pct.toFixed(0)} %
                        </span>
                      </div>
                    ) : null}
                  </div>
                );
              })}
          </div>
        </section>

        {/* 3. Devices & Checkpoints Status */}
        <section className="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xl">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <h3 className="text-base font-bold text-white">Appareils et Portes Actives</h3>
            <a
              href={`/api/v1/events/${selectedEventId}/export/movements.csv`}
              download
              className="inline-flex items-center gap-1.5 min-h-11 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Exporter CSV
            </a>
          </div>

          {/* The table keeps its own horizontal scroll area rather than
              widening the page: six columns of device state do not fit a
              phone, and folding them into cards is a redesign this phase
              does not do. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-xs text-slate-300">
              <thead className="border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
                <tr>
                  <th className="py-3 px-4">Porte / Checkpoint</th>
                  <th className="py-3 px-4">Appareil</th>
                  <th className="py-3 px-4">Statut</th>
                  <th className="py-3 px-4">Dernier Contact</th>
                  <th className="py-3 px-4">En Attente</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {eventDetail?.devices.map((dev: any) => (
                  <tr key={dev.id} className="hover:bg-slate-950/40">
                    <td className="py-3 px-4 font-sans font-medium text-white">{dev.checkpointName}</td>
                    <td className="py-3 px-4 font-sans text-slate-300">{dev.label}</td>
                    <td className="py-3 px-4">
                      {dev.isOnline ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-500/30 text-[11px] font-sans font-semibold">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                          Connecté
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-rose-950 text-rose-400 border border-rose-500/30 text-[11px] font-sans font-semibold">
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
                          Hors ligne
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-400">
                      {dev.lastSeenAtMs ? new Date(dev.lastSeenAtMs).toLocaleTimeString('fr-FR') : '—'}
                    </td>
                    <td className="py-3 px-4">
                      {dev.lastPendingCount > 0 ? (
                        <span className="text-amber-400 font-bold">{dev.lastPendingCount} actions</span>
                      ) : (
                        <span className="text-slate-500">0</span>
                      )}
                    </td>
                  </tr>
                ))}
                {eventDetail?.devices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-slate-500 font-sans">
                      Aucun appareil appairé pour le moment.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
};
