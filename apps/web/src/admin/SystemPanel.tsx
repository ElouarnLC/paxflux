import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { SystemStatusResponse } from '@paxflux/shared';
import {
  HardDrive,
  Database,
  CheckCircle,
  AlertTriangle,
  ArrowLeft,
  RefreshCw,
  Download,
  Plus,
} from 'lucide-react';

export const SystemPanel: React.FC = () => {
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  const [backups, setBackups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);

  const fetchStatus = async () => {
    try {
      const [st, bkList] = await Promise.all([
        apiFetch<SystemStatusResponse>('/api/v1/system/status'),
        apiFetch<any[]>('/api/v1/system/backups'),
      ]);
      setStatus(st);
      setBackups(bkList);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleManualBackup = async () => {
    setBackingUp(true);
    try {
      await apiFetch('/api/v1/system/backups', {
        method: 'POST',
        body: JSON.stringify({ reason: 'admin_manual' }),
      });
      fetchStatus();
    } catch {
      // ignore
    } finally {
      setBackingUp(false);
    }
  };

  if (loading || !status) {
    return (
      <div className="min-h-full flex items-center justify-center bg-slate-950 text-slate-400">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="min-h-full bg-slate-950 text-slate-100 p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <Link
          to="/admin"
          className="inline-flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Retour au tableau de bord
        </Link>
        <h1 className="text-xl font-bold text-white">État Système & Sauvegardes</h1>
      </div>

      {/* 1. System Health Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-5 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">Version</span>
          <span className="text-2xl font-black font-mono text-white">{status.version}</span>
          <span className="text-[11px] text-slate-500 block mt-0.5">{status.nodeVersion}</span>
        </div>

        <div className="p-5 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">Intégrité DB</span>
          <span className="text-2xl font-black font-mono text-emerald-400">
            {status.database.quickCheckOk ? 'OK' : 'ATTENTION'}
          </span>
          <span className="text-[11px] text-slate-500 block mt-0.5">PRAGMA quick_check</span>
        </div>

        <div className="p-5 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">Taille Base</span>
          <span className="text-2xl font-black font-mono text-white">
            {(status.database.sizeBytes / 1024).toFixed(1)} <span className="text-sm font-normal text-slate-500">KB</span>
          </span>
          <span className="text-[11px] text-slate-500 block mt-0.5">
            WAL: {(status.database.walSizeBytes / 1024).toFixed(1)} KB
          </span>
        </div>

        <div className="p-5 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">Uptime</span>
          <span className="text-2xl font-black font-mono text-indigo-400">
            {Math.floor(status.uptimeSeconds / 60)} <span className="text-sm font-normal text-slate-500">min</span>
          </span>
          <span className="text-[11px] text-slate-500 block mt-0.5">{status.connectedSSECount} flux SSE actifs</span>
        </div>
      </div>

      {/* 2. Backups Management */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
            Historique des Sauvegardes SQLite
          </h2>
          <button
            type="button"
            disabled={backingUp}
            onClick={handleManualBackup}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-lg"
          >
            {backingUp ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Créer une sauvegarde maintenant
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
              <tr>
                <th className="py-3 px-4">Fichier</th>
                <th className="py-3 px-4">Motif</th>
                <th className="py-3 px-4">Taille</th>
                <th className="py-3 px-4">SHA-256</th>
                <th className="py-3 px-4">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 font-mono">
              {backups.map((b) => (
                <tr key={b.id}>
                  <td className="py-3 px-4 font-sans font-medium text-white">{b.filename}</td>
                  <td className="py-3 px-4 font-sans text-slate-400">{b.reason}</td>
                  <td className="py-3 px-4 text-slate-300">{(b.sizeBytes / 1024).toFixed(1)} KB</td>
                  <td className="py-3 px-4 text-slate-500 truncate max-w-xs">{b.sha256.substring(0, 16)}...</td>
                  <td className="py-3 px-4 text-slate-400">
                    {new Date(b.createdAtMs).toLocaleString('fr-FR')}
                  </td>
                </tr>
              ))}
              {backups.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-500 font-sans">
                    Aucune sauvegarde enregistrée.
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
