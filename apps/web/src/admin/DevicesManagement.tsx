import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { QRCodeSVG } from 'qrcode.react';
import {
  QrCode,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  RefreshCw,
} from 'lucide-react';
import {
  CreateDeviceInviteResponse,
  CheckpointModel,
  EventDeviceSummary,
  ProblemDetails,
} from '@paxflux/shared';

const DEVICES_POLL_INTERVAL_MS = 5_000;

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; devices: EventDeviceSummary[]; checkpoints: CheckpointModel[] }
  | { kind: 'error'; detail: string };

function errorDetail(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'detail' in err) {
    return String((err as ProblemDetails).detail);
  }
  return fallback;
}

function formatLastSeen(lastSeenAtMs: number | null): string {
  if (!lastSeenAtMs) return '—';
  return new Date(lastSeenAtMs).toLocaleTimeString('fr-FR');
}

export const DevicesManagement: React.FC = () => {
  const { id: eventId } = useParams<{ id: string }>();
  const [listState, setListState] = useState<ListState>({ kind: 'loading' });
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string>('');
  const [activeInvite, setActiveInvite] = useState<CreateDeviceInviteResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // `silent` (background polling, or a manual refresh with a list already
  // on screen) keeps the current rows visible instead of flashing back to a
  // skeleton, and never replaces good data with a transient fetch error.
  const fetchDevices = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!eventId) return;
      if (!opts.silent) setListState({ kind: 'loading' });
      setRefreshing(true);
      try {
        const [devList, cpList] = await Promise.all([
          apiFetch<EventDeviceSummary[]>(`/api/v1/events/${eventId}/devices`),
          apiFetch<CheckpointModel[]>(`/api/v1/events/${eventId}/checkpoints`),
        ]);
        setListState({ kind: 'ready', devices: devList, checkpoints: cpList });
        setSelectedCheckpointId((current) =>
          current && cpList.some((cp) => cp.id === current) ? current : cpList[0]?.id || ''
        );
      } catch (err) {
        setListState((prev) =>
          opts.silent && prev.kind === 'ready'
            ? prev
            : { kind: 'error', detail: errorDetail(err, 'Impossible de charger les appareils de cet événement.') }
        );
      } finally {
        setRefreshing(false);
      }
    },
    [eventId]
  );

  // A device goes online or drains its outbox entirely on its own — nothing
  // the admin does here triggers a re-render. Poll while this page is open
  // so the list is current without a manual reload. One request at a time:
  // each tick waits for the previous fetch before scheduling the next.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (silent: boolean) => {
      await fetchDevices({ silent });
      if (!cancelled) {
        timer = setTimeout(() => tick(true), DEVICES_POLL_INTERVAL_MS);
      }
    };

    tick(false);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchDevices]);

  const handleCreateInvite = async () => {
    if (!eventId || !selectedCheckpointId) return;
    setCreating(true);
    setActionError(null);
    try {
      // The pairing URL comes from the server (PUBLIC_BASE_URL, or the
      // request origin) and is used exactly as returned. Rebuilding it from
      // window.location would encode whatever origin the admin happens to
      // be browsing — typically localhost — into a QR meant for a phone.
      const invite = await apiFetch<CreateDeviceInviteResponse>(`/api/v1/events/${eventId}/device-invites`, {
        method: 'POST',
        body: JSON.stringify({
          checkpointId: selectedCheckpointId,
          expiresInMinutes: 30,
        }),
      });
      setActiveInvite(invite);
    } catch (err) {
      setActiveInvite(null);
      setActionError(errorDetail(err, 'Impossible de générer le QR code d’appairage.'));
    } finally {
      setCreating(false);
    }
  };

  const handleRevokeDevice = async (sessionId: string) => {
    if (!confirm('Voulez-vous vraiment révoquer cet appareil ? Il ne pourra plus envoyer de comptages.')) return;
    setActionError(null);
    try {
      await apiFetch(`/api/v1/device-sessions/${sessionId}/revoke`, { method: 'POST' });
      await fetchDevices({ silent: true });
    } catch (err) {
      setActionError(errorDetail(err, 'Impossible de révoquer cet appareil.'));
    }
  };

  const devices = listState.kind === 'ready' ? listState.devices : [];
  const checkpoints = listState.kind === 'ready' ? listState.checkpoints : [];

  return (
    // `w-full` is load-bearing, not decoration: this page is a flex item of
    // #root, and a flex item with `auto` cross-axis margins (`mx-auto`) is
    // not stretched to its container — it sizes to its content instead. Two
    // admin pages were therefore as wide as their widest table, which
    // `overflow-x-hidden` on <body> used to hide.
    <div className="min-h-full bg-slate-950 text-slate-100 p-4 sm:p-6 w-full max-w-5xl mx-auto space-y-4 sm:space-y-6">
      {/* "back on the left, title on the right" is a desktop pattern; on a
          phone the two simply collide, so they stack with the title first. */}
      <div className="flex flex-col sm:flex-row-reverse sm:items-center sm:justify-between gap-1 sm:gap-3">
        <h1 className="text-lg sm:text-xl font-bold text-white break-words">Gestion des Appareils et QR Codes</h1>
        <Link
          to="/admin"
          className="inline-flex items-center gap-2 self-start min-h-11 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" /> Retour au tableau de bord
        </Link>
      </div>

      {actionError ? (
        <div className="p-3.5 rounded-2xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs flex gap-2.5 items-start">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-400" />
          <span>{actionError}</span>
        </div>
      ) : null}

      {/* 1. Generate Invite Section */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xl">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4">
          Ajouter un Appareil Compteur
        </h2>

        <div className="flex flex-col sm:flex-row gap-4 items-end">
          <div className="flex-1 w-full">
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Choisir la porte / le checkpoint :
            </label>
            <select
              value={selectedCheckpointId}
              onChange={(e) => setSelectedCheckpointId(e.target.value)}
              className="w-full min-w-0 min-h-11 px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-base md:text-sm"
            >
              {checkpoints.map((cp) => (
                <option key={cp.id} value={cp.id}>
                  {cp.name}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            disabled={creating || !selectedCheckpointId}
            onClick={handleCreateInvite}
            className="w-full sm:w-auto min-h-11 px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg transition-all"
          >
            <QrCode className="w-4 h-4 flex-shrink-0" />
            Générer le QR Code d'appairage
          </button>
        </div>

        {/* QR Code Display Modal / Box. The 180px code keeps its size —
            smaller scans badly — so the panel's own padding is what gives
            way at 320px, and the text column shrinks beside it. */}
        {activeInvite ? (
          <div className="mt-6 p-4 sm:p-6 rounded-2xl bg-slate-950 border border-indigo-500/40 flex flex-col md:flex-row items-center gap-4 sm:gap-6">
            <div className="flex-shrink-0 p-3 sm:p-4 bg-white rounded-2xl shadow-xl">
              <QRCodeSVG value={activeInvite.pairUrl} size={180} level="M" />
            </div>

            <div className="w-full min-w-0 space-y-3 text-center md:text-left flex-1">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-500/30">
                <CheckCircle className="w-3.5 h-3.5" />
                QR Code Prêt pour scan
              </span>
              <p className="text-sm font-bold text-white">Scannez ce QR Code avec l'appareil photo du téléphone.</p>
              <p className="text-xs text-slate-400 leading-relaxed">
                Le secret d'appairage est transmis dans le fragment URL et ne sera pas stocké dans les logs serveur. Valable 30 minutes, à usage unique.
              </p>

              {activeInvite.unreachableFromPhone ? (
                <div className="p-3 rounded-xl bg-amber-950/60 border border-amber-500/40 text-amber-200 text-xs flex items-start gap-2 text-left">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-400" />
                  <span>
                    Cette URL pointe vers une adresse locale à ce serveur : un téléphone ne pourra pas l'ouvrir.
                    Configurez <span className="font-mono">PUBLIC_BASE_URL</span>, ou ouvrez PaxFlux via l'adresse
                    réseau que les téléphones peuvent joindre.
                  </span>
                </div>
              ) : null}

              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-[11px] font-mono text-slate-400 break-all select-all">
                {activeInvite.pairUrl}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* 2. Registered Devices List */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
            Appareils Enregistrés ({devices.length})
          </h2>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => fetchDevices({ silent: true })}
            className="inline-flex items-center gap-1.5 min-h-11 px-3 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-50 text-[11px] font-semibold transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} /> Actualiser
          </button>
        </div>

        {listState.kind === 'loading' ? (
          <p className="text-xs text-slate-400 flex items-center gap-2 py-4">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Chargement des appareils…
          </p>
        ) : listState.kind === 'error' ? (
          <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/30 text-rose-200 text-xs flex items-start gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p>{listState.detail}</p>
              <button
                type="button"
                onClick={() => fetchDevices()}
                className="mt-2 inline-flex items-center gap-1.5 min-h-11 px-3 rounded-lg bg-rose-900/60 hover:bg-rose-900 text-rose-100 font-semibold"
              >
                <RefreshCw className="w-3 h-3" /> Réessayer
              </button>
            </div>
          </div>
        ) : (
          // Six columns of device state stay in their own scroll area
          // rather than widening the page.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left text-xs text-slate-300">
              <thead className="border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
                <tr>
                  <th className="py-3 px-4">Porte</th>
                  <th className="py-3 px-4">Libellé</th>
                  <th className="py-3 px-4">Statut</th>
                  <th className="py-3 px-4">En attente</th>
                  <th className="py-3 px-4">Dernier Contact</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 font-mono">
                {devices.map((dev) => (
                  <tr key={dev.id}>
                    <td className="py-3 px-4 font-sans font-medium text-white">{dev.checkpointName}</td>
                    <td className="py-3 px-4 font-sans text-slate-300">{dev.label}</td>
                    <td className="py-3 px-4 font-sans">
                      {/* isOnline is computed server-side against the shared
                          threshold, so this matches what the closing gate
                          sees rather than a second frontend approximation. */}
                      {dev.isOnline ? (
                        <span className="text-emerald-400 font-semibold">● En ligne</span>
                      ) : (
                        <span className="text-rose-400 font-semibold">● Hors ligne</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {dev.lastPendingCount > 0 ? (
                        <span className="text-amber-400 font-semibold">{dev.lastPendingCount}</span>
                      ) : (
                        <span className="text-slate-500">0</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-400">{formatLastSeen(dev.lastSeenAtMs)}</td>
                    <td className="py-3 px-4 text-right font-sans">
                      <button
                        type="button"
                        onClick={() => handleRevokeDevice(dev.id)}
                        className="min-h-11 px-3 rounded-lg bg-rose-950/60 hover:bg-rose-900 border border-rose-500/40 text-rose-300 text-xs font-semibold transition-colors"
                      >
                        Révoquer
                      </button>
                    </td>
                  </tr>
                ))}
                {devices.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-500 font-sans">
                      Aucun appareil connecté.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
