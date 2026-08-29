import React, { useState } from 'react';
import { apiFetch } from '../api/client.js';
import { Sliders, AlertCircle, Loader2, CheckCircle } from 'lucide-react';

interface AdjustmentsModalProps {
  eventId: string;
  spaces: Array<{ id: string; name: string; kind: string }>;
  currentOccupancies: Record<string, number>;
  onClose: () => void;
  onSuccess: () => void;
}

export const AdjustmentsModal: React.FC<AdjustmentsModalProps> = ({
  eventId,
  spaces,
  currentOccupancies,
  onClose,
  onSuccess,
}) => {
  const leafSpaces = spaces.filter((s) => s.kind === 'leaf');
  const [selectedSpaceId, setSelectedSpaceId] = useState(leafSpaces[0]?.id || '');
  const [observedCount, setObservedCount] = useState<number>(
    currentOccupancies[leafSpaces[0]?.id] || 0
  );
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentSystemCount = currentOccupancies[selectedSpaceId] || 0;
  const delta = observedCount - currentSystemCount;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason || reason.trim().length < 3) {
      setError('Un motif explicite d’au moins 3 caractères est obligatoire.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await apiFetch(`/api/v1/events/${eventId}/adjustments`, {
        method: 'POST',
        body: JSON.stringify({
          spaceId: selectedSpaceId,
          observedCount,
          reason: reason.trim(),
        }),
      });

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.detail || 'Erreur lors de l’application de la correction.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="max-w-lg w-full bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl text-left text-slate-100">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-amber-950/80 border border-amber-500/40 flex items-center justify-center text-amber-400">
            <Sliders className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Correction de Jauge Supervisée</h2>
            <p className="text-xs text-slate-400">Ajustement audité dans le journal des mouvements.</p>
          </div>
        </div>

        {error ? (
          <div className="mb-4 p-3 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs flex gap-2 items-start">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Zone à corriger</label>
            <select
              value={selectedSpaceId}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedSpaceId(id);
                setObservedCount(currentOccupancies[id] || 0);
              }}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm"
            >
              {leafSpaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4 p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
            <div>
              <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold block mb-0.5">
                Valeur Système
              </span>
              <span className="text-2xl font-black font-mono text-slate-300">{currentSystemCount}</span>
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-0.5">
                Valeur Observée Réelle *
              </label>
              <input
                type="number"
                min="0"
                required
                value={observedCount}
                onChange={(e) => setObservedCount(parseInt(e.target.value, 10) || 0)}
                className="w-full px-3 py-1 rounded-lg bg-slate-900 border border-slate-700 text-xl font-bold font-mono text-white"
              />
            </div>
          </div>

          <div className="p-3 rounded-xl bg-indigo-950/40 border border-indigo-500/30 text-xs text-indigo-200 flex justify-between items-center">
            <span>Correction nette calculée :</span>
            <span className="font-mono font-bold text-sm">
              {delta > 0 ? `+${delta}` : delta}
            </span>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Motif de la correction *</label>
            <textarea
              required
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex: Recomptage manuel après coupure réseau temporaire"
              className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-white text-xs focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="pt-2 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-lg"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Appliquer la correction
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
