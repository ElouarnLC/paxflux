import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { Plus, Trash2, ArrowRight, ArrowLeft, CheckCircle, AlertCircle, Layers } from 'lucide-react';
import { EventModel } from '@paxflux/shared';

export const EventWizard: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // Step 1: General
  const [name, setName] = useState('Campulsations 2026');
  const [capacity, setCapacity] = useState(1500);
  const [warningRatio1, setWarningRatio1] = useState(0.8);
  const [warningRatio2, setWarningRatio2] = useState(0.9);
  const [timezone, setTimezone] = useState('Europe/Paris');

  // Step 2: Zones Mode
  const [mode, setMode] = useState<'single' | 'multi'>('single');
  const [customZones, setCustomZones] = useState<Array<{ name: string; capacity?: number }>>([
    { name: 'Zone Générale', capacity: 1200 },
    { name: 'VIP', capacity: 150 },
    { name: 'Salle A', capacity: 150 },
  ]);

  // Step 3: Checkpoints
  const [checkpoints, setCheckpoints] = useState<Array<{
    name: string;
    fromName: string;
    toName: string;
    labelAtoB: string;
    labelBtoA: string;
  }>>([
    {
      name: 'Porte Principale',
      fromName: 'Extérieur',
      toName: 'Site',
      labelAtoB: 'ENTRÉE +1',
      labelBtoA: 'SORTIE −1',
    },
  ]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreateEvent = async () => {
    setLoading(true);
    setError(null);

    try {
      // 1. Create Event
      const eventRes = await apiFetch<EventModel>('/api/v1/events', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          capacity,
          warningRatio1,
          warningRatio2,
          timezone,
        }),
      });

      // If multi zone mode, create additional spaces and checkpoints
      if (mode === 'multi') {
        const spacesRes = await apiFetch<any[]>(`/api/v1/events/${eventRes.id}/spaces`);
        const extSpace = spacesRes.find((s) => s.kind === 'external');

        for (const zone of customZones) {
          const sp = await apiFetch<any>(`/api/v1/events/${eventRes.id}/spaces`, {
            method: 'POST',
            body: JSON.stringify({
              name: zone.name,
              kind: 'leaf',
              capacity: zone.capacity,
            }),
          });

          // Create checkpoint for this zone
          await apiFetch(`/api/v1/events/${eventRes.id}/checkpoints`, {
            method: 'POST',
            body: JSON.stringify({
              name: `Accès ${zone.name}`,
              spaceAId: extSpace.id,
              spaceBId: sp.id,
              allowAToB: true,
              allowBToA: true,
              labelAToB: `→ ${zone.name}`,
              labelBToA: `← SORTIE`,
            }),
          });
        }
      } else {
        // Create default checkpoint for single mode
        const spacesRes = await apiFetch<any[]>(`/api/v1/events/${eventRes.id}/spaces`);
        const extSpace = spacesRes.find((s) => s.kind === 'external');
        const siteSpace = spacesRes.find((s) => s.kind === 'leaf');

        await apiFetch(`/api/v1/events/${eventRes.id}/checkpoints`, {
          method: 'POST',
          body: JSON.stringify({
            name: checkpoints[0]?.name || 'Porte Principale',
            spaceAId: extSpace.id,
            spaceBId: siteSpace.id,
            allowAToB: true,
            allowBToA: true,
            labelAToB: checkpoints[0]?.labelAtoB || 'ENTRÉE +1',
            labelBToA: checkpoints[0]?.labelBtoA || 'SORTIE −1',
          }),
        });
      }

      // The event is created in `draft`. Staff review the topology and run
      // the preflight check from the dashboard before explicitly starting
      // it live — the wizard itself never starts an event.
      navigate('/admin', { replace: true });
    } catch (err: any) {
      setError(err.detail || 'Erreur lors de la création de l’événement.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full bg-slate-950 text-slate-100 flex flex-col p-6 items-center justify-center">
      <div className="max-w-2xl w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl">
        {/* Step Indicator */}
        <div className="flex items-center justify-between mb-8">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                  step === s
                    ? 'bg-indigo-600 text-white'
                    : step > s
                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/40'
                    : 'bg-slate-800 text-slate-500'
                }`}
              >
                {step > s ? '✓' : s}
              </div>
              <span className="text-xs font-semibold text-slate-400 hidden sm:inline">
                {s === 1 ? 'Général' : s === 2 ? 'Zones' : s === 3 ? 'Portes' : 'Validation'}
              </span>
            </div>
          ))}
        </div>

        {error ? (
          <div className="mb-6 p-3.5 rounded-2xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs flex gap-2.5 items-start">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-400" />
            <span>{error}</span>
          </div>
        ) : null}

        {/* Step 1: General */}
        {step === 1 ? (
          <div className="space-y-4">
            <h2 className="text-xl font-bold text-white mb-1">1. Informations Générales</h2>
            <p className="text-slate-400 text-xs mb-4">Définissez le nom et la jauge maximale autorisée.</p>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">Nom de l'événement *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Capacité maximale (jauge) *</label>
                <input
                  type="number"
                  min="1"
                  value={capacity}
                  onChange={(e) => setCapacity(parseInt(e.target.value, 10) || 0)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Fuseau horaire</label>
                <input
                  type="text"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="pt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center gap-1.5"
              >
                Suivant <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : null}

        {/* Step 2: Zone Model */}
        {step === 2 ? (
          <div className="space-y-4">
            <h2 className="text-xl font-bold text-white mb-1">2. Modèle de Zones</h2>
            <p className="text-slate-400 text-xs mb-4">Choisissez si votre site a une seule jauge ou plusieurs sous-espaces.</p>

            <div className="grid grid-cols-2 gap-4 my-4">
              <button
                type="button"
                onClick={() => setMode('single')}
                className={`p-4 rounded-2xl border text-left transition-all ${
                  mode === 'single'
                    ? 'bg-indigo-950/60 border-indigo-500/80 text-white'
                    : 'bg-slate-950 border-slate-800 text-slate-400'
                }`}
              >
                <h3 className="font-bold text-sm text-white mb-1">Jauge globale unique</h3>
                <p className="text-xs text-slate-400">Le site est compté en bloc (Extérieur ⇄ Site).</p>
              </button>

              <button
                type="button"
                onClick={() => setMode('multi')}
                className={`p-4 rounded-2xl border text-left transition-all ${
                  mode === 'multi'
                    ? 'bg-indigo-950/60 border-indigo-500/80 text-white'
                    : 'bg-slate-950 border-slate-800 text-slate-400'
                }`}
              >
                <h3 className="font-bold text-sm text-white mb-1">Plusieurs zones internes</h3>
                <p className="text-xs text-slate-400">Ex: Zone Générale, Salle A, VIP, Terrasse.</p>
              </button>
            </div>

            {mode === 'multi' ? (
              <div className="space-y-2 mt-4">
                <label className="block text-xs font-semibold text-slate-300">Zones internes mutuellement exclusives :</label>
                {customZones.map((z, idx) => (
                  <div key={idx} className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={z.name}
                      onChange={(e) => {
                        const copy = [...customZones];
                        copy[idx].name = e.target.value;
                        setCustomZones(copy);
                      }}
                      className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white"
                    />
                    <input
                      type="number"
                      placeholder="Capacité"
                      value={z.capacity || ''}
                      onChange={(e) => {
                        const copy = [...customZones];
                        copy[idx].capacity = parseInt(e.target.value, 10) || undefined;
                        setCustomZones(copy);
                      }}
                      className="w-28 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white font-mono"
                    />
                  </div>
                ))}
              </div>
            ) : null}

            <div className="pt-4 flex justify-between">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs flex items-center gap-1.5"
              >
                <ArrowLeft className="w-4 h-4" /> Retour
              </button>
              <button
                type="button"
                onClick={() => setStep(3)}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center gap-1.5"
              >
                Suivant <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : null}

        {/* Step 3: Checkpoints */}
        {step === 3 ? (
          <div className="space-y-4">
            <h2 className="text-xl font-bold text-white mb-1">3. Portes & Checkpoints</h2>
            <p className="text-slate-400 text-xs mb-4">Configurez les portes physiques et les libellés de boutons.</p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Nom de la porte principale</label>
                <input
                  type="text"
                  value={checkpoints[0]?.name || ''}
                  onChange={(e) => {
                    const copy = [...checkpoints];
                    copy[0].name = e.target.value;
                    setCheckpoints(copy);
                  }}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Bouton Entrée</label>
                  <input
                    type="text"
                    value={checkpoints[0]?.labelAtoB || ''}
                    onChange={(e) => {
                      const copy = [...checkpoints];
                      copy[0].labelAtoB = e.target.value;
                      setCheckpoints(copy);
                    }}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Bouton Sortie</label>
                  <input
                    type="text"
                    value={checkpoints[0]?.labelBtoA || ''}
                    onChange={(e) => {
                      const copy = [...checkpoints];
                      copy[0].labelBtoA = e.target.value;
                      setCheckpoints(copy);
                    }}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm"
                  />
                </div>
              </div>
            </div>

            <div className="pt-4 flex justify-between">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs flex items-center gap-1.5"
              >
                <ArrowLeft className="w-4 h-4" /> Retour
              </button>
              <button
                type="button"
                onClick={() => setStep(4)}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center gap-1.5"
              >
                Suivant <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : null}

        {/* Step 4: Validation */}
        {step === 4 ? (
          <div className="space-y-4">
            <h2 className="text-xl font-bold text-white mb-1">4. Validation de la Topologie</h2>
            <p className="text-slate-400 text-xs mb-4">
              Vérifiez la structure, puis enregistrez l'événement en brouillon. Vous le lancerez explicitement depuis le tableau de bord, après vérification du préflight.
            </p>

            <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300 space-y-2">
              <p>Événement : <strong className="text-white">{name}</strong> (Capacité : {capacity})</p>
              <p>Mode : <strong className="text-white">{mode === 'single' ? 'Jauge unique' : 'Plusieurs zones'}</strong></p>
              <div className="mt-3 p-3 bg-slate-900 rounded-xl">
                <p className="text-emerald-400 font-semibold mb-1">Topologie :</p>
                <p className="text-slate-300">[ EXTÉRIEUR ]</p>
                <p className="text-indigo-400">   ⇅ {checkpoints[0]?.name || 'Porte'}</p>
                <p className="text-slate-300">[ {mode === 'single' ? 'SITE' : 'ZONE GÉNÉRALE'} ]</p>
              </div>
            </div>

            <div className="pt-4 flex justify-between">
              <button
                type="button"
                onClick={() => setStep(3)}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs flex items-center gap-1.5"
              >
                <ArrowLeft className="w-4 h-4" /> Retour
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={handleCreateEvent}
                className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-2 shadow-lg shadow-emerald-950/60"
              >
                <CheckCircle className="w-4 h-4" />
                Créer l'événement (brouillon)
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
