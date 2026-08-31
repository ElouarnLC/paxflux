import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { AnalyticsResponse } from '@paxflux/shared';
import {
  TrendingUp,
  TrendingDown,
  Activity,
  ArrowLeft,
  RefreshCw,
  Clock,
  Download,
} from 'lucide-react';

export const AnalyticsView: React.FC = () => {
  const { id: eventId } = useParams<{ id: string }>();
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAnalytics() {
      if (!eventId) return;
      try {
        const res = await apiFetch<AnalyticsResponse>(`/api/v1/events/${eventId}/analytics`);
        setData(res);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    loadAnalytics();
  }, [eventId]);

  if (loading || !data) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950 text-slate-400">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="flex-1 bg-slate-950 text-slate-100 p-4 sm:p-6 w-full max-w-6xl mx-auto space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row-reverse sm:items-center sm:justify-between gap-1 sm:gap-3">
        <h1 className="text-lg sm:text-xl font-bold text-white break-words">Statistiques & Analyse de Flux</h1>
        <Link
          to="/admin"
          className="inline-flex items-center gap-2 self-start min-h-11 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" /> Retour au tableau de bord
        </Link>
      </div>

      {/* 1. Key Performance Stats Cards. Two columns at 320px gives each
          card about 130px, which is not enough for "Pic de Fréquentation"
          above a five-figure number — so the pair only forms once there is
          room for it. */}
      <div className="grid grid-cols-1 min-[400px]:grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <div className="p-4 sm:p-5 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
            Jauge Actuelle
          </span>
          <span className="text-2xl sm:text-3xl font-black font-mono break-words text-white">
            {data.currentOccupancy} <span className="text-sm font-normal text-slate-500">/ {data.capacity}</span>
          </span>
        </div>

        <div className="p-4 sm:p-5 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
            Pic de Fréquentation
          </span>
          <span className="text-2xl sm:text-3xl font-black font-mono break-words text-indigo-400">{data.peakOccupancy}</span>
          <span className="text-[11px] text-slate-500 block mt-0.5">
            {data.peakOccupancyTimeMs ? new Date(data.peakOccupancyTimeMs).toLocaleTimeString('fr-FR') : '—'}
          </span>
        </div>

        <div className="p-4 sm:p-5 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
            Entrées Cumulées
          </span>
          <span className="text-2xl sm:text-3xl font-black font-mono break-words text-emerald-400">+{data.totalEntries}</span>
          <span className="text-[11px] text-slate-500 block mt-0.5">depuis l'extérieur</span>
        </div>

        <div className="p-4 sm:p-5 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
            Sorties Cumulées
          </span>
          <span className="text-2xl sm:text-3xl font-black font-mono break-words text-rose-400">−{data.totalExits}</span>
          <span className="text-[11px] text-slate-500 block mt-0.5">vers l'extérieur</span>
        </div>
      </div>

      {/* 2. Checkpoint Breakdown Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xl">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4">
          Flux Cumulés par Porte
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-left text-xs text-slate-300">
            <thead className="border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
              <tr>
                <th className="py-3 px-4">Porte</th>
                <th className="py-3 px-4">Entrées</th>
                <th className="py-3 px-4">Sorties</th>
                <th className="py-3 px-4">Solde Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 font-mono">
              {data.checkpointStats.map((cp: any) => (
                <tr key={cp.checkpointId}>
                  <td className="py-3 px-4 font-sans font-medium text-white">{cp.checkpointName}</td>
                  <td className="py-3 px-4 text-emerald-400">+{cp.entries}</td>
                  <td className="py-3 px-4 text-rose-400">−{cp.exits}</td>
                  <td className="py-3 px-4 font-bold text-white">
                    {cp.entries - cp.exits > 0 ? `+${cp.entries - cp.exits}` : cp.entries - cp.exits}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
