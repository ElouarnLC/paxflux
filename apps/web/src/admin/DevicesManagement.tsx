import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { QRCodeSVG } from 'qrcode.react';
import {
  QrCode,
  Plus,
  Trash2,
  Edit2,
  Smartphone,
  CheckCircle,
  AlertCircle,
  ArrowLeft,
  RefreshCw,
} from 'lucide-react';
import { CreateDeviceInviteResponse } from '@paxflux/shared';

export const DevicesManagement: React.FC = () => {
  const { id: eventId } = useParams<{ id: string }>();
  const [devices, setDevices] = useState<any[]>([]);
  const [checkpoints, setCheckpoints] = useState<any[]>([]);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string>('');
  const [activeInvite, setActiveInvite] = useState<CreateDeviceInviteResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const fetchDevices = async () => {
    if (!eventId) return;
    try {
      const [devList, cpList] = await Promise.all([
        apiFetch<any[]>(`/api/v1/events/${eventId}/devices`),
        apiFetch<any[]>(`/api/v1/events/${eventId}/checkpoints`),
      ]);
      setDevices(devList);
      setCheckpoints(cpList);
      if (cpList.length > 0 && !selectedCheckpointId) {
        setSelectedCheckpointId(cpList[0].id);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDevices();
  }, [eventId]);

  const handleCreateInvite = async () => {
    if (!eventId || !selectedCheckpointId) return;
    setCreating(true);
    try {
      const invite = await apiFetch<CreateDeviceInviteResponse>(`/api/v1/events/${eventId}/device-invites`, {
        method: 'POST',
        body: JSON.stringify({
          checkpointId: selectedCheckpointId,
          expiresInMinutes: 30,
        }),
      });

      // Construct full pairing URL with current window location host
      const fullUrl = `${window.location.origin}/pair#${invite.token}`;
      setActiveInvite({
        ...invite,
        pairUrl: fullUrl,
      });
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  };

  const handleRevokeDevice = async (sessionId: string) => {
    if (!confirm('Voulez-vous vraiment révoquer cet appareil ? Il ne pourra plus envoyer de comptages.')) return;
    try {
      await apiFetch(`/api/v1/device-sessions/${sessionId}/revoke`, { method: 'POST' });
      fetchDevices();
    } catch {
      // ignore
    }
  };

  return (
    <div className="min-h-full bg-slate-950 text-slate-100 p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <Link
          to="/admin"
          className="inline-flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Retour au tableau de bord
        </Link>
        <h1 className="text-xl font-bold text-white">Gestion des Appareils et QR Codes</h1>
      </div>

      {/* 1. Generate Invite Section */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl">
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
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm focus:outline-none"
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
            className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center gap-2 shadow-lg transition-all"
          >
            <QrCode className="w-4 h-4" />
            Générer le QR Code d'appairage
          </button>
        </div>

        {/* QR Code Display Modal / Box */}
        {activeInvite ? (
          <div className="mt-6 p-6 rounded-2xl bg-slate-950 border border-indigo-500/40 flex flex-col md:flex-row items-center gap-6">
            <div className="p-4 bg-white rounded-2xl shadow-xl">
              <QRCodeSVG value={activeInvite.pairUrl} size={180} level="M" />
            </div>

            <div className="space-y-3 text-center md:text-left flex-1">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-500/30">
                <CheckCircle className="w-3.5 h-3.5" />
                QR Code Prêt pour scan
              </span>
              <p className="text-sm font-bold text-white">Scannez ce QR Code avec l'appareil photo du téléphone.</p>
              <p className="text-xs text-slate-400 leading-relaxed">
                Le secret d'appairage est transmis dans le fragment URL et ne sera pas stocké dans les logs serveur. Valable 30 minutes, à usage unique.
              </p>
              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-[11px] font-mono text-slate-400 break-all select-all">
                {activeInvite.pairUrl}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* 2. Registered Devices List */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4">
          Appareils Enregistrés ({devices.length})
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
              <tr>
                <th className="py-3 px-4">Porte</th>
                <th className="py-3 px-4">Libellé</th>
                <th className="py-3 px-4">Statut</th>
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
                    {dev.isOnline ? (
                      <span className="text-emerald-400 font-semibold">● En ligne</span>
                    ) : (
                      <span className="text-rose-400 font-semibold">● Hors ligne</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-slate-400">
                    {dev.lastSeenAtMs ? new Date(dev.lastSeenAtMs).toLocaleTimeString('fr-FR') : '—'}
                  </td>
                  <td className="py-3 px-4 text-right font-sans">
                    <button
                      type="button"
                      onClick={() => handleRevokeDevice(dev.id)}
                      className="px-3 py-1 rounded-lg bg-rose-950/60 hover:bg-rose-900 border border-rose-500/40 text-rose-300 text-xs font-semibold transition-colors"
                    >
                      Révoquer
                    </button>
                  </td>
                </tr>
              ))}
              {devices.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-500 font-sans">
                    Aucun appareil connecté.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
