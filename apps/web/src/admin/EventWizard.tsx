import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { Plus, Trash2, ArrowRight, ArrowLeft, CheckCircle, AlertCircle } from 'lucide-react';
import { CreateEventDraftRequest, CreateEventDraftResponse } from '@paxflux/shared';

const EXTERIOR_CLIENT_ID = 'exterieur';

interface SpaceDraft {
  clientId: string;
  name: string;
  capacity: number | '';
}

interface CheckpointDraft {
  key: string;
  name: string;
  spaceAClientId: string;
  spaceBClientId: string;
  allowAToB: boolean;
  allowBToA: boolean;
  labelAToB: string;
  labelBToA: string;
}

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const EventWizard: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // Step 1: General
  const [name, setName] = useState('Campulsations 2026');
  const [capacity, setCapacity] = useState(1500);
  const [warningRatio1] = useState(0.8);
  const [warningRatio2] = useState(0.9);
  const [timezone, setTimezone] = useState('Europe/Paris');

  // Step 2: Spaces. "Extérieur" always exists (SPEC: boundary counting
  // requires it) and isn't part of this editable list — only the internal
  // zones staff actually chooses are. A zone needs no door of its own back
  // to Extérieur: it can be reached only through another internal zone
  // (e.g. VIP via Site<->VIP), so nothing here forces one.
  const [internalSpaces, setInternalSpaces] = useState<SpaceDraft[]>([{ clientId: newId(), name: 'Site', capacity: 1500 }]);

  const allSpaceOptions = [{ clientId: EXTERIOR_CLIENT_ID, name: 'Extérieur' }, ...internalSpaces.map((s) => ({ clientId: s.clientId, name: s.name }))];

  // Step 3: Checkpoints — a plain list, freely editable: any number of
  // checkpoints, any pair of endpoints (external<->internal or
  // internal<->internal), each direction togglable independently with its
  // own label.
  const [checkpointDrafts, setCheckpointDrafts] = useState<CheckpointDraft[]>([
    {
      key: newId(),
      name: 'Porte Principale',
      spaceAClientId: EXTERIOR_CLIENT_ID,
      spaceBClientId: internalSpaces[0].clientId,
      allowAToB: true,
      allowBToA: true,
      labelAToB: 'ENTRÉE +1',
      labelBToA: 'SORTIE −1',
    },
  ]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addInternalSpace() {
    setInternalSpaces((prev) => [...prev, { clientId: newId(), name: '', capacity: '' }]);
  }

  function removeInternalSpace(clientId: string) {
    setInternalSpaces((prev) => prev.filter((s) => s.clientId !== clientId));
    setCheckpointDrafts((prev) => prev.filter((cp) => cp.spaceAClientId !== clientId && cp.spaceBClientId !== clientId));
  }

  function updateInternalSpace(clientId: string, patch: Partial<SpaceDraft>) {
    setInternalSpaces((prev) => prev.map((s) => (s.clientId === clientId ? { ...s, ...patch } : s)));
  }

  function addCheckpoint() {
    setCheckpointDrafts((prev) => [
      ...prev,
      {
        key: newId(),
        name: `Porte ${prev.length + 1}`,
        spaceAClientId: EXTERIOR_CLIENT_ID,
        spaceBClientId: internalSpaces[0]?.clientId || EXTERIOR_CLIENT_ID,
        allowAToB: true,
        allowBToA: true,
        labelAToB: 'ENTRÉE +1',
        labelBToA: 'SORTIE −1',
      },
    ]);
  }

  function removeCheckpoint(key: string) {
    setCheckpointDrafts((prev) => prev.filter((cp) => cp.key !== key));
  }

  function updateCheckpoint(key: string, patch: Partial<CheckpointDraft>) {
    setCheckpointDrafts((prev) => prev.map((cp) => (cp.key === key ? { ...cp, ...patch } : cp)));
  }

  function spaceName(clientId: string): string {
    return allSpaceOptions.find((s) => s.clientId === clientId)?.name || '?';
  }

  const handleCreateEvent = async () => {
    setLoading(true);
    setError(null);

    const payload: CreateEventDraftRequest = {
      event: {
        name: name.trim(),
        capacity,
        warningRatio1,
        warningRatio2,
        timezone,
      },
      spaces: [
        { clientId: EXTERIOR_CLIENT_ID, name: 'Extérieur', kind: 'external', sortOrder: 0 },
        ...internalSpaces.map((s, idx) => ({
          clientId: s.clientId,
          name: s.name.trim(),
          kind: 'leaf' as const,
          capacity: s.capacity === '' ? null : s.capacity,
          sortOrder: idx + 1,
        })),
      ],
      checkpoints: checkpointDrafts.map((cp, idx) => ({
        name: cp.name.trim(),
        spaceAClientId: cp.spaceAClientId,
        spaceBClientId: cp.spaceBClientId,
        allowAToB: cp.allowAToB,
        allowBToA: cp.allowBToA,
        labelAToB: cp.labelAToB.trim(),
        labelBToA: cp.labelBToA.trim(),
        sortOrder: idx,
      })),
    };

    try {
      // Single atomic request: event + spaces + checkpoints are created
      // together in one server-side transaction (domain/topology.ts). No
      // intermediate state can ever be left behind by a mid-flow failure.
      const res = await apiFetch<CreateEventDraftResponse>('/api/v1/events/drafts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      // The event is created in `draft`. Open that specific event on the
      // dashboard for review — not just "/admin", which would otherwise
      // default to an existing live event and hide the new draft. Staff
      // run the preflight check and explicitly start it live from there;
      // the wizard itself never starts an event.
      navigate(`/admin?event=${res.event.id}`, { replace: true });
    } catch (err: any) {
      setError(err.detail || 'Erreur lors de la création de l’événement.');
    } finally {
      setLoading(false);
    }
  };

  const canGoToCheckpoints = internalSpaces.every((s) => s.name.trim().length > 0);
  const canCreate =
    name.trim().length > 0 &&
    canGoToCheckpoints &&
    checkpointDrafts.length > 0 &&
    checkpointDrafts.every((cp) => cp.name.trim().length > 0 && cp.labelAToB.trim().length > 0 && cp.labelBToA.trim().length > 0 && (cp.allowAToB || cp.allowBToA));

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
                {s === 1 ? 'Général' : s === 2 ? 'Espaces' : s === 3 ? 'Portes' : 'Validation'}
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

        {/* Step 2: Spaces */}
        {step === 2 ? (
          <div className="space-y-4">
            <h2 className="text-xl font-bold text-white mb-1">2. Espaces</h2>
            <p className="text-slate-400 text-xs mb-4">
              "Extérieur" existe toujours pour le comptage de frontière. Ajoutez les zones intérieures utiles — une zone
              n'a pas forcément besoin de sa propre porte vers l'extérieur.
            </p>

            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300 font-semibold">
              Extérieur <span className="text-slate-500 font-normal">(frontière, toujours présent)</span>
            </div>

            <div className="space-y-2">
              {internalSpaces.map((s) => (
                <div key={s.clientId} className="flex gap-2 items-center">
                  <input
                    type="text"
                    aria-label="Nom de l'espace intérieur"
                    placeholder="Nom de la zone"
                    value={s.name}
                    onChange={(e) => updateInternalSpace(s.clientId, { name: e.target.value })}
                    className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white"
                  />
                  <input
                    type="number"
                    aria-label="Capacité de l'espace"
                    placeholder="Capacité"
                    value={s.capacity}
                    onChange={(e) => updateInternalSpace(s.clientId, { capacity: e.target.value === '' ? '' : parseInt(e.target.value, 10) || 0 })}
                    className="w-28 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white font-mono"
                  />
                  <button
                    type="button"
                    aria-label="Supprimer cet espace"
                    disabled={internalSpaces.length <= 1}
                    onClick={() => removeInternalSpace(s.clientId)}
                    className="p-2 rounded-xl text-rose-400 hover:bg-rose-950/40 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={addInternalSpace}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs"
            >
              <Plus className="w-3.5 h-3.5" /> Ajouter un espace intérieur
            </button>

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
                disabled={!canGoToCheckpoints}
                onClick={() => setStep(3)}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-bold text-xs flex items-center gap-1.5"
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
            <p className="text-slate-400 text-xs mb-4">
              Configurez autant de portes physiques que nécessaire, y compris plusieurs entre les deux mêmes espaces.
            </p>

            <div className="space-y-3">
              {checkpointDrafts.map((cp) => (
                <div key={cp.key} className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800 space-y-2.5">
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      aria-label="Nom de la porte"
                      value={cp.name}
                      onChange={(e) => updateCheckpoint(cp.key, { name: e.target.value })}
                      className="flex-1 px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-white text-sm"
                    />
                    <button
                      type="button"
                      aria-label="Supprimer cette porte"
                      disabled={checkpointDrafts.length <= 1}
                      onClick={() => removeCheckpoint(cp.key)}
                      className="p-2 rounded-xl text-rose-400 hover:bg-rose-950/40 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-500 mb-1">Espace A</label>
                      <select
                        aria-label="Espace A"
                        value={cp.spaceAClientId}
                        onChange={(e) => updateCheckpoint(cp.key, { spaceAClientId: e.target.value })}
                        className="w-full px-2.5 py-2 rounded-xl bg-slate-900 border border-slate-800 text-white text-xs"
                      >
                        {allSpaceOptions.map((opt) => (
                          <option key={opt.clientId} value={opt.clientId}>
                            {opt.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-500 mb-1">Espace B</label>
                      <select
                        aria-label="Espace B"
                        value={cp.spaceBClientId}
                        onChange={(e) => updateCheckpoint(cp.key, { spaceBClientId: e.target.value })}
                        className="w-full px-2.5 py-2 rounded-xl bg-slate-900 border border-slate-800 text-white text-xs"
                      >
                        {allSpaceOptions.map((opt) => (
                          <option key={opt.clientId} value={opt.clientId}>
                            {opt.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        aria-label="Sens A vers B activé"
                        checked={cp.allowAToB}
                        onChange={(e) => updateCheckpoint(cp.key, { allowAToB: e.target.checked })}
                      />
                      <input
                        type="text"
                        aria-label="Libellé A vers B"
                        value={cp.labelAToB}
                        onChange={(e) => updateCheckpoint(cp.key, { labelAToB: e.target.value })}
                        placeholder={`${spaceName(cp.spaceAClientId)} → ${spaceName(cp.spaceBClientId)}`}
                        className="flex-1 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-white text-xs"
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        aria-label="Sens B vers A activé"
                        checked={cp.allowBToA}
                        onChange={(e) => updateCheckpoint(cp.key, { allowBToA: e.target.checked })}
                      />
                      <input
                        type="text"
                        aria-label="Libellé B vers A"
                        value={cp.labelBToA}
                        onChange={(e) => updateCheckpoint(cp.key, { labelBToA: e.target.value })}
                        placeholder={`${spaceName(cp.spaceBClientId)} → ${spaceName(cp.spaceAClientId)}`}
                        className="flex-1 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-white text-xs"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={addCheckpoint}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs"
            >
              <Plus className="w-3.5 h-3.5" /> Ajouter une porte
            </button>

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
                disabled={!canCreate}
                onClick={() => setStep(4)}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-bold text-xs flex items-center gap-1.5"
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
              Vérifiez la structure, puis enregistrez l'événement en brouillon. Vous le lancerez explicitement depuis le
              tableau de bord, après vérification du préflight.
            </p>

            <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 text-xs text-slate-300 space-y-3">
              <p>
                Événement : <strong className="text-white">{name}</strong> (Capacité : {capacity})
              </p>

              <div>
                <p className="text-emerald-400 font-semibold mb-1">Espaces ({allSpaceOptions.length})</p>
                <ul className="space-y-0.5">
                  {allSpaceOptions.map((s) => (
                    <li key={s.clientId} className="text-slate-300">
                      • {s.name}
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="text-indigo-400 font-semibold mb-1">Checkpoints ({checkpointDrafts.length})</p>
                <ul className="space-y-0.5">
                  {checkpointDrafts.map((cp) => (
                    <li key={cp.key} className="text-slate-300">
                      • {cp.name} — {spaceName(cp.spaceAClientId)} ⇄ {spaceName(cp.spaceBClientId)}
                      {cp.allowAToB ? ` (${cp.labelAToB})` : ''}
                      {cp.allowBToA ? ` / (${cp.labelBToA})` : ''}
                    </li>
                  ))}
                </ul>
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
