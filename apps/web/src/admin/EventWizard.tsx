import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { Plus, Trash2, ArrowRight, ArrowLeft, CheckCircle, AlertCircle } from 'lucide-react';
import {
  CreateEventDraftRequest,
  CreateEventDraftResponse,
  detectDefaultTimezone,
  isValidTimezone,
} from '@paxflux/shared';
import {
  CapacityFieldState,
  applyEventCapacity,
  describeDirection,
  generatedLabel,
  independentCapacity,
  linkedCapacity,
  overrideCapacity,
  relabelForEndpoints,
  LabelFieldState,
  editedLabel,
} from './draft-form.js';
import { TimezoneField } from './TimezoneField.js';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardPanel } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';

const STEP_NAMES = ['Général', 'Espaces', 'Portes', 'Validation'] as const;

const EXTERIOR_CLIENT_ID = 'exterieur';

/** The sentinel and the first zone, for generating default labels. */
const EXTERIOR_SPACE = { name: 'Extérieur', kind: 'external' as const };
const FIRST_ZONE = { name: 'Site', kind: 'leaf' as const };

interface SpaceDraft {
  clientId: string;
  name: string;
  /**
   * Capacity plus whether it is still following the event's.
   *
   * The relationship is form state, never inferred: see `draft-form.ts`.
   */
  capacity: CapacityFieldState;
}

interface CheckpointDraft {
  key: string;
  name: string;
  spaceAClientId: string;
  spaceBClientId: string;
  allowAToB: boolean;
  allowBToA: boolean;
  /** Label plus whether it is still a generated suggestion. */
  labelAToB: LabelFieldState;
  labelBToA: LabelFieldState;
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
  const [capacity, setCapacityState] = useState(1500);

  /**
   * Sets the event capacity and carries every still-linked zone with it.
   *
   * A zone the operator has explicitly set keeps its own number: see
   * `applyEventCapacity`.
   */
  function setCapacity(next: number) {
    setCapacityState(next);
    setInternalSpaces((prev) =>
      prev.map((s) => ({ ...s, capacity: applyEventCapacity(s.capacity, next) }))
    );
  }
  const [warningRatio1] = useState(0.8);
  const [warningRatio2] = useState(0.9);
  // The operator's own zone is right far more often than any constant; it
  // is validated before use and falls back only if unusable.
  const [timezone, setTimezone] = useState(() => detectDefaultTimezone());

  // Step 2: Spaces. "Extérieur" always exists (SPEC: boundary counting
  // requires it) and isn't part of this editable list — only the internal
  // zones staff actually chooses are. A zone needs no door of its own back
  // to Extérieur: it can be reached only through another internal zone
  // (e.g. VIP via Site<->VIP), so nothing here forces one.
  // The first zone starts linked to the event capacity: the operator has
  // not yet said anything about it, and two independent 1500s that drift
  // apart the moment the event capacity changes is the defect this fixes.
  const [internalSpaces, setInternalSpaces] = useState<SpaceDraft[]>([
    { clientId: newId(), name: 'Site', capacity: linkedCapacity(1500) },
  ]);

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
      labelAToB: generatedLabel(EXTERIOR_SPACE, FIRST_ZONE),
      labelBToA: generatedLabel(FIRST_ZONE, EXTERIOR_SPACE),
    },
  ]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addInternalSpace() {
    // Additional zones answer to nobody from the start.
    setInternalSpaces((prev) => [...prev, { clientId: newId(), name: '', capacity: independentCapacity('') }]);
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
        labelAToB: generatedLabel(EXTERIOR_SPACE, FIRST_ZONE),
        labelBToA: generatedLabel(FIRST_ZONE, EXTERIOR_SPACE),
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

  /** A zone as the wording helpers see it: a name and whether it is the sentinel. */
  function spaceLike(clientId: string) {
    return {
      name: spaceName(clientId),
      kind: clientId === EXTERIOR_CLIENT_ID ? ('external' as const) : ('leaf' as const),
    };
  }

  /**
   * Moves one end of a door.
   *
   * A label that is still a generated suggestion follows the new zones,
   * which is the useful part; one the operator wrote is left exactly as
   * typed. Provenance is recorded when the label is set, never guessed from
   * the text afterwards.
   */
  function changeEndpoint(cp: CheckpointDraft, patch: Partial<Pick<CheckpointDraft, 'spaceAClientId' | 'spaceBClientId'>>) {
    const spaceAClientId = patch.spaceAClientId ?? cp.spaceAClientId;
    const spaceBClientId = patch.spaceBClientId ?? cp.spaceBClientId;
    const from = spaceLike(spaceAClientId);
    const to = spaceLike(spaceBClientId);

    updateCheckpoint(cp.key, {
      spaceAClientId,
      spaceBClientId,
      labelAToB: relabelForEndpoints(cp.labelAToB, from, to),
      labelBToA: relabelForEndpoints(cp.labelBToA, to, from),
    });
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
          capacity: s.capacity.capacity === '' ? null : s.capacity.capacity,
          sortOrder: idx + 1,
        })),
      ],
      checkpoints: checkpointDrafts.map((cp, idx) => ({
        name: cp.name.trim(),
        spaceAClientId: cp.spaceAClientId,
        spaceBClientId: cp.spaceBClientId,
        allowAToB: cp.allowAToB,
        allowBToA: cp.allowBToA,
        labelAToB: cp.labelAToB.value.trim(),
        labelBToA: cp.labelBToA.value.trim(),
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
    isValidTimezone(timezone) &&
    canGoToCheckpoints &&
    checkpointDrafts.length > 0 &&
    checkpointDrafts.every(
      (cp) =>
        cp.name.trim().length > 0 &&
        cp.labelAToB.value.trim().length > 0 &&
        cp.labelBToA.value.trim().length > 0 &&
        (cp.allowAToB || cp.allowBToA)
    );

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6">
      <Card className="w-full max-w-2xl p-4 sm:p-8">
        {/* Step indicator — the four markers must fit 320px on their own,
            which is why the step names only appear from `sm` up. */}
        <ol className="mb-6 flex items-center justify-between gap-1 sm:mb-8">
          {[1, 2, 3, 4].map((s) => (
            <li key={s} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                  step === s
                    ? 'bg-primary text-primary-foreground'
                    : step > s
                      ? 'border border-success/40 bg-success/15 text-success'
                      : 'bg-muted text-muted-foreground'
                )}
              >
                {step > s ? '✓' : s}
              </span>
              <span
                aria-current={step === s ? 'step' : undefined}
                className={cn(
                  'hidden text-xs font-semibold sm:inline',
                  step === s ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {STEP_NAMES[s - 1]}
              </span>
            </li>
          ))}
        </ol>

        {error ? (
          <Alert tone="danger" className="mb-6">
            <AlertCircle />
            <AlertDescription className="mt-0 text-foreground/90">{error}</AlertDescription>
          </Alert>
        ) : null}

        {/* Step 1: General */}
        {step === 1 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-foreground">1. Informations Générales</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Définissez le nom et la jauge maximale autorisée.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="event-name">Nom de l’événement *</Label>
              <Input
                id="event-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {/* Two columns of ~120px at 320px leaves no room for a capacity
                and a timezone; they stack until there is. */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="event-capacity">Capacité maximale (jauge) *</Label>
                <Input
                  id="event-capacity"
                  type="number"
                  min="1"
                  value={capacity}
                  onChange={(e) => setCapacity(parseInt(e.target.value, 10) || 0)}
                  className="font-mono"
                />
              </div>

              <TimezoneField value={timezone} onChange={setTimezone} />
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-4">
              {/* A timezone the engine cannot resolve is refused by the
                  server too, so the operator learns it here rather than
                  after filling three more steps. */}
              <Button disabled={!isValidTimezone(timezone)} onClick={() => setStep(2)}>
                Suivant <ArrowRight />
              </Button>
            </div>
          </div>
        ) : null}

        {/* Step 2: Spaces */}
        {step === 2 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-foreground">2. Espaces</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                "Extérieur" existe toujours pour le comptage de frontière. Ajoutez les zones intérieures
                utiles — une zone n’a pas forcément besoin de sa propre porte vers l’extérieur.
              </p>
            </div>

            <CardPanel className="text-xs font-semibold text-foreground/90">
              Extérieur <span className="font-normal text-muted-foreground">(frontière, toujours présent)</span>
            </CardPanel>

            <div className="space-y-2">
              {internalSpaces.map((s) => (
                // Name, capacity and delete on one 320px row leaves the name
                // field about 100px wide and pushes the row past the
                // viewport. The name takes its own line below `sm`, and the
                // capacity shares the second one with the delete button.
                <div key={s.clientId} className="flex flex-wrap items-center gap-2">
                  <Input
                    type="text"
                    aria-label="Nom de l’espace intérieur"
                    placeholder="Nom de la zone"
                    value={s.name}
                    onChange={(e) => updateInternalSpace(s.clientId, { name: e.target.value })}
                    className="w-full sm:flex-1"
                  />
                  <Input
                    type="number"
                    aria-label="Capacité de l’espace"
                    placeholder="Capacité"
                    value={s.capacity.capacity}
                    onChange={(e) =>
                      updateInternalSpace(s.clientId, {
                        // Typing here ends the link, even to the same number:
                        // it is an explicit statement that this zone owns its
                        // capacity from now on.
                        capacity: overrideCapacity(
                          s.capacity,
                          e.target.value === '' ? '' : parseInt(e.target.value, 10) || 0
                        ),
                      })
                    }
                    className="flex-1 font-mono sm:w-28 sm:flex-none"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Supprimer cet espace"
                    disabled={internalSpaces.length <= 1}
                    onClick={() => removeInternalSpace(s.clientId)}
                    className="shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>

            <Button variant="secondary" size="sm" onClick={addInternalSpace}>
              <Plus className="size-3.5" /> Ajouter un espace intérieur
            </Button>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-4">
              <Button variant="secondary" onClick={() => setStep(1)}>
                <ArrowLeft /> Retour
              </Button>
              <Button disabled={!canGoToCheckpoints} onClick={() => setStep(3)}>
                Suivant <ArrowRight />
              </Button>
            </div>
          </div>
        ) : null}

        {/* Step 3: Checkpoints */}
        {step === 3 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-foreground">3. Portes</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Configurez autant de portes physiques que nécessaire, y compris plusieurs entre les deux
                mêmes espaces.
              </p>
            </div>

            <div className="space-y-3">
              {checkpointDrafts.map((cp) => (
                <CardPanel key={cp.key} className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      aria-label="Nom de la porte"
                      value={cp.name}
                      onChange={(e) => updateCheckpoint(cp.key, { name: e.target.value })}
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Supprimer cette porte"
                      disabled={checkpointDrafts.length <= 1}
                      onClick={() => removeCheckpoint(cp.key)}
                      className="shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 />
                    </Button>
                  </div>

                  {/* Two endpoint selectors, then two direction labels: each
                      pair collapses to one column when two would be too
                      narrow to read the space names in. */}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Première zone</Label>
                      <NativeSelect
                        aria-label="Première zone de la porte"
                        value={cp.spaceAClientId}
                        onChange={(e) => changeEndpoint(cp, { spaceAClientId: e.target.value })}
                      >
                        {allSpaceOptions.map((opt) => (
                          <option key={opt.clientId} value={opt.clientId}>
                            {opt.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Deuxième zone</Label>
                      <NativeSelect
                        aria-label="Deuxième zone de la porte"
                        value={cp.spaceBClientId}
                        onChange={(e) => changeEndpoint(cp, { spaceBClientId: e.target.value })}
                      >
                        {allSpaceOptions.map((opt) => (
                          <option key={opt.clientId} value={opt.clientId}>
                            {opt.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  </div>

                  {/* Directions read as the movement they are. "A → B" is
                      the ledger's vocabulary, not the field's: someone at a
                      door thinks "from the outside into the site". And for an
                      internal transfer there is no global entrée/sortie —
                      Site → VIP is neither. */}
                  <div className="space-y-2">
                    {([
                      { key: 'aToB' as const, from: cp.spaceAClientId, to: cp.spaceBClientId, allowed: cp.allowAToB, label: cp.labelAToB },
                      { key: 'bToA' as const, from: cp.spaceBClientId, to: cp.spaceAClientId, allowed: cp.allowBToA, label: cp.labelBToA },
                    ]).map((direction) => (
                      <div key={direction.key} className="space-y-1.5">
                        <div className="flex items-center gap-1">
                          {/* The box stays 20×20 so it still reads as a
                              checkbox; the <label> around it is the target a
                              thumb actually hits. */}
                          <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
                            <input
                              type="checkbox"
                              className="size-5 accent-[var(--color-primary)]"
                              aria-label={`Autoriser ${describeDirection(spaceLike(direction.from), spaceLike(direction.to))}`}
                              checked={direction.allowed}
                              onChange={(e) =>
                                updateCheckpoint(
                                  cp.key,
                                  direction.key === 'aToB'
                                    ? { allowAToB: e.target.checked }
                                    : { allowBToA: e.target.checked }
                                )
                              }
                            />
                          </label>
                          <span className="min-w-0 break-words text-xs font-semibold text-foreground">
                            {describeDirection(spaceLike(direction.from), spaceLike(direction.to))}
                          </span>
                        </div>
                        <Input
                          type="text"
                          aria-label={`Libellé du bouton : ${describeDirection(spaceLike(direction.from), spaceLike(direction.to))}`}
                          value={direction.label.value}
                          disabled={!direction.allowed}
                          onChange={(e) =>
                            updateCheckpoint(
                              cp.key,
                              direction.key === 'aToB'
                                ? { labelAToB: editedLabel(e.target.value) }
                                : { labelBToA: editedLabel(e.target.value) }
                            )
                          }
                          className="w-full"
                        />
                      </div>
                    ))}
                    {!cp.allowAToB && !cp.allowBToA ? (
                      <p className="text-xs font-semibold text-danger">
                        Une porte doit autoriser au moins un sens de passage.
                      </p>
                    ) : null}
                  </div>
                </CardPanel>
              ))}
            </div>

            <Button variant="secondary" size="sm" onClick={addCheckpoint}>
              <Plus className="size-3.5" /> Ajouter une porte
            </Button>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-4">
              <Button variant="secondary" onClick={() => setStep(2)}>
                <ArrowLeft /> Retour
              </Button>
              <Button disabled={!canCreate} onClick={() => setStep(4)}>
                Suivant <ArrowRight />
              </Button>
            </div>
          </div>
        ) : null}

        {/* Step 4: Validation */}
        {step === 4 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-foreground">4. Validation de la Topologie</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Vérifiez la structure, puis enregistrez l’événement en brouillon. Vous le lancerez
                explicitement depuis le tableau de bord, après vérification du préflight.
              </p>
            </div>

            <CardPanel className="space-y-3 p-4 text-xs text-foreground/80">
              <p>
                Événement : <strong className="break-words text-foreground">{name}</strong> (Capacité :{' '}
                {capacity})
              </p>

              <div>
                <p className="mb-1 font-semibold text-success">Espaces ({allSpaceOptions.length})</p>
                <ul className="space-y-0.5">
                  {allSpaceOptions.map((s) => (
                    <li key={s.clientId} className="break-words">
                      • {s.name}
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="mb-1 font-semibold text-primary-accent">
                  Checkpoints ({checkpointDrafts.length})
                </p>
                <ul className="space-y-0.5">
                  {checkpointDrafts.map((cp) => (
                    <li key={cp.key} className="break-words">
                      • {cp.name} — {spaceName(cp.spaceAClientId)} ⇄ {spaceName(cp.spaceBClientId)}
                      {cp.allowAToB ? ` (${cp.labelAToB})` : ''}
                      {cp.allowBToA ? ` / (${cp.labelBToA})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            </CardPanel>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-4">
              <Button variant="secondary" onClick={() => setStep(3)}>
                <ArrowLeft /> Retour
              </Button>
              <Button variant="success" disabled={loading} onClick={handleCreateEvent}>
                <CheckCircle />
                Créer l’événement (brouillon)
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
};
