import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import {
  EventDetailResponse,
  EventModel,
  PreflightResponse,
  ProblemDetails,
  SpaceModel,
  isValidTimezone,
} from '@paxflux/shared';
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardPanel } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { PageHeader, Section } from '@/components/paxflux/layout';
import { StatusBadge, eventStatusKey } from '@/components/paxflux/status';
import { TimezoneField } from './TimezoneField.js';
import {
  EditableCheckpoint,
  EditableSpace,
  applyEventCapacity,
  describeDirection,
  describePreflightError,
  describeSpace,
  editedLabel,
  hasEditableCapacity,
  hasUsableDirections,
  overrideCapacity,
  relabelForEndpoints,
  relinkCapacity,
  toEditableCheckpoints,
  toEditableSpaces,
} from './draft-form.js';

/**
 * Editing a draft's preparation before it goes live.
 *
 * Everything here mutates the *existing* entities. Nothing is deleted and
 * recreated to emulate an edit: a space or checkpoint id may already be
 * pointed at by a device invitation, a paired session, or a counter's own
 * stored configuration, and churning ids would quietly break all three.
 *
 * Each field saves as its own request against its own entity, and after any
 * save the whole draft is re-read from the server. That is deliberate: a
 * multi-step save can partially succeed, and the honest thing is to show
 * what actually persisted rather than to claim the whole form went through.
 */

function errorDetail(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'detail' in err) {
    return String((err as ProblemDetails).detail);
  }
  return fallback;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; atMs: number }
  | { kind: 'failed'; detail: string };

interface DraftState {
  event: EventModel;
  spaces: EditableSpace[];
  checkpoints: EditableCheckpoint[];
}

type PreflightState =
  | { kind: 'unknown' }
  | { kind: 'ready'; data: PreflightResponse }
  | { kind: 'error'; detail: string };

export const DraftEditor: React.FC = () => {
  const { id: eventId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  // The server's own go-live verdict, re-read after every structural edit.
  // The editor never re-derives it: a topology this screen thinks is fine is
  // still only ready when `/preflight` — the same check `/start` runs — says
  // so.
  const [preflight, setPreflight] = useState<PreflightState>({ kind: 'unknown' });

  // Event fields are edited locally and committed explicitly, so a slow
  // keystroke never races a request.
  const [name, setName] = useState('');
  const [capacity, setCapacityState] = useState(0);
  const [timezone, setTimezone] = useState('');

  /**
   * Re-reads the draft from the server and rebuilds the form from it.
   *
   * The server is the authority after every mutation: what it returns is
   * what persisted, including anything a partially-applied save left behind.
   */
  const reload = useCallback(async () => {
    if (!eventId) return;
    try {
      const detail = await apiFetch<EventDetailResponse>(`/api/v1/events/${eventId}/state`);
      setDraft({
        event: detail.event,
        spaces: toEditableSpaces(detail.spaces),
        checkpoints: toEditableCheckpoints(detail.checkpoints),
      });
      setName(detail.event.name);
      setCapacityState(detail.event.capacity);
      setTimezone(detail.event.timezone);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorDetail(err, 'Impossible de charger ce brouillon.'));
      setLoading(false);
      return;
    }

    // Structural edits do not bump `event.version`, so a stale verdict has
    // nothing to invalidate it. It is refetched explicitly instead, on the
    // same trip that re-reads the draft.
    try {
      const verdict = await apiFetch<PreflightResponse>(`/api/v1/events/${eventId}/preflight`);
      setPreflight({ kind: 'ready', data: verdict });
    } catch (err) {
      setPreflight({ kind: 'error', detail: errorDetail(err, 'Impossible de vérifier la préparation.') });
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * Runs one mutation, then re-reads the draft.
   *
   * A failure is reported as a failure: the message is the server's, the
   * form keeps what the operator typed, and nothing claims to have been
   * saved. The reload afterwards is what stops the screen from drifting away
   * from the server — including when the event left `draft` under us, which
   * the server answers with `TOPOLOGY_LOCKED`.
   */
  const mutate = useCallback(
    async (run: () => Promise<unknown>): Promise<boolean> => {
      setSave({ kind: 'saving' });
      try {
        await run();
        await reload();
        setSave({ kind: 'saved', atMs: Date.now() });
        return true;
      } catch (err) {
        setSave({ kind: 'failed', detail: errorDetail(err, 'La modification n’a pas pu être enregistrée.') });
        // Still re-read: a refused mutation tells us the server's view may
        // differ from ours, and showing the real state is the point.
        await reload();
        return false;
      }
    },
    [reload]
  );

  function setCapacity(next: number) {
    setCapacityState(next);
    setDraft((prev) =>
      prev
        ? { ...prev, spaces: prev.spaces.map((s) => ({ ...s, capacity: applyEventCapacity(s.capacity, next) })) }
        : prev
    );
  }

  const saveEvent = () =>
    mutate(() =>
      apiFetch(`/api/v1/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), capacity, timezone }),
      })
    );

  const saveSpace = (space: EditableSpace) =>
    mutate(() =>
      apiFetch(`/api/v1/events/${eventId}/spaces/${space.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: space.name.trim(),
          ...(hasEditableCapacity(space)
            ? { capacity: space.capacity.capacity === '' ? null : space.capacity.capacity }
            : {}),
        }),
      })
    );

  const addSpace = () =>
    mutate(() =>
      apiFetch(`/api/v1/events/${eventId}/spaces`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Nouvelle zone',
          kind: 'leaf',
          capacity: null,
          sortOrder: (draft?.spaces.length ?? 1) + 1,
        }),
      })
    );

  const deleteSpace = (space: EditableSpace) =>
    mutate(() => apiFetch(`/api/v1/events/${eventId}/spaces/${space.id}`, { method: 'DELETE' }));

  const saveCheckpoint = (checkpoint: EditableCheckpoint) =>
    mutate(() =>
      apiFetch(`/api/v1/events/${eventId}/checkpoints/${checkpoint.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: checkpoint.name.trim(),
          spaceAId: checkpoint.spaceAId,
          spaceBId: checkpoint.spaceBId,
          allowAToB: checkpoint.allowAToB,
          allowBToA: checkpoint.allowBToA,
          labelAToB: checkpoint.labelAToB.value.trim(),
          labelBToA: checkpoint.labelBToA.value.trim(),
        }),
      })
    );

  const addCheckpoint = () => {
    const zones = draft?.spaces.filter((s) => s.kind !== 'aggregate') ?? [];
    const first = zones.find((s) => s.kind === 'external') ?? zones[0];
    const second = zones.find((s) => s.id !== first?.id);
    if (!first || !second) return Promise.resolve(false);

    return mutate(() =>
      apiFetch(`/api/v1/events/${eventId}/checkpoints`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Nouvelle porte',
          spaceAId: first.id,
          spaceBId: second.id,
          allowAToB: true,
          allowBToA: true,
          labelAToB: 'ENTRÉE +1',
          labelBToA: 'SORTIE −1',
          sortOrder: (draft?.checkpoints.length ?? 0) + 1,
        }),
      })
    );
  };

  const deleteCheckpoint = (checkpoint: EditableCheckpoint) =>
    mutate(() => apiFetch(`/api/v1/events/${eventId}/checkpoints/${checkpoint.id}`, { method: 'DELETE' }));

  function updateSpace(id: string, patch: Partial<EditableSpace>) {
    setDraft((prev) =>
      prev ? { ...prev, spaces: prev.spaces.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : prev
    );
  }

  function updateCheckpoint(id: string, patch: Partial<EditableCheckpoint>) {
    setDraft((prev) =>
      prev ? { ...prev, checkpoints: prev.checkpoints.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : prev
    );
  }

  function spaceOf(id: string): { name: string; kind: SpaceModel['kind'] } {
    const found = draft?.spaces.find((s) => s.id === id);
    return found ? { name: found.name, kind: found.kind } : { name: '—', kind: 'leaf' };
  }

  /** Moving an endpoint carries generated labels along; edited ones stay. */
  function changeEndpoint(checkpoint: EditableCheckpoint, patch: { spaceAId?: string; spaceBId?: string }) {
    const spaceAId = patch.spaceAId ?? checkpoint.spaceAId;
    const spaceBId = patch.spaceBId ?? checkpoint.spaceBId;
    const from = spaceOf(spaceAId);
    const to = spaceOf(spaceBId);
    updateCheckpoint(checkpoint.id, {
      spaceAId,
      spaceBId,
      labelAToB: relabelForEndpoints(checkpoint.labelAToB, from, to),
      labelBToA: relabelForEndpoints(checkpoint.labelBToA, to, from),
    });
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <RefreshCw className="size-8 animate-spin text-primary-accent" />
      </div>
    );
  }

  if (loadError || !draft) {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 p-4 sm:p-6">
        <Alert tone="danger">
          <AlertCircle />
          <div className="min-w-0">
            <AlertTitle>Brouillon indisponible</AlertTitle>
            <AlertDescription>{loadError ?? 'Ce brouillon est introuvable.'}</AlertDescription>
          </div>
        </Alert>
        <Button asChild variant="secondary" className="mt-4">
          <Link to="/admin">
            <ArrowLeft /> Retour à la supervision
          </Link>
        </Button>
      </div>
    );
  }

  // The editor is for preparation. Once an event is live its topology is
  // locked server-side, and pretending otherwise would invite an operator to
  // type changes that can only be refused.
  if (draft.event.status !== 'draft') {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 p-4 sm:p-6">
        <PageHeader title="Préparation verrouillée" />
        <Alert tone="warning">
          <AlertCircle />
          <div className="min-w-0">
            <AlertTitle>
              Cet événement n’est plus un brouillon <StatusBadge status={eventStatusKey(draft.event.status)} />
            </AlertTitle>
            <AlertDescription>
              La topologie d’un événement est verrouillée dès son passage en direct, pour que le journal des mouvements
              garde le sens qu’il avait au moment du comptage.
            </AlertDescription>
          </div>
        </Alert>
        <Button asChild variant="secondary">
          <Link to={`/admin?event=${draft.event.id}`}>
            <ArrowLeft /> Retour à la supervision
          </Link>
        </Button>
      </div>
    );
  }

  const zonesForEndpoints = draft.spaces.filter((s) => s.kind !== 'aggregate');

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 space-y-4 p-4 sm:space-y-6 sm:p-6">
      <PageHeader
        title="Modifier le brouillon"
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link to={`/admin?event=${draft.event.id}`}>
              <ArrowLeft /> Supervision
            </Link>
          </Button>
        }
      />

      {/* Save feedback is written, and a failure never reads as a success. */}
      <div aria-live="polite" data-testid="draft-save-state">
        {save.kind === 'saving' ? (
          <p className="text-xs font-semibold text-muted-foreground">
            <Loader2 className="mr-1 inline size-3.5 animate-spin" /> Enregistrement…
          </p>
        ) : null}
        {save.kind === 'saved' ? (
          <p className="text-xs font-semibold text-success">
            <CheckCircle2 className="mr-1 inline size-3.5" /> Enregistré à{' '}
            {new Date(save.atMs).toLocaleTimeString('fr-FR')}
          </p>
        ) : null}
        {save.kind === 'failed' ? (
          <Alert tone="danger">
            <AlertCircle />
            <div className="min-w-0">
              <AlertTitle>Modification non enregistrée</AlertTitle>
              <AlertDescription>{save.detail}</AlertDescription>
            </div>
          </Alert>
        ) : null}
      </div>

      <Section title="Événement">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="draft-name">Nom de l’événement</Label>
            <Input id="draft-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="draft-capacity">Capacité maximale</Label>
              <Input
                id="draft-capacity"
                type="number"
                min="0"
                className="font-mono"
                value={capacity}
                onChange={(e) => setCapacity(parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <TimezoneField value={timezone} onChange={setTimezone} />
          </div>

          <Button
            onClick={saveEvent}
            disabled={save.kind === 'saving' || name.trim().length === 0 || !isValidTimezone(timezone)}
          >
            Enregistrer l’événement
          </Button>
        </div>
      </Section>

      <Section
        title="Zones"
        actions={
          <Button variant="secondary" size="sm" onClick={addSpace} disabled={save.kind === 'saving'}>
            <Plus className="size-3.5" /> Ajouter une zone
          </Button>
        }
      >
        <div className="space-y-3">
          {draft.spaces.map((space) => (
            <CardPanel key={space.id} className="space-y-2">
              {space.kind === 'external' ? (
                // The sentinel exists so a crossing has somewhere to come
                // from. It holds nobody, so it is named for what it is and
                // offers no capacity to edit.
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span data-testid="external-space" className="text-sm font-semibold text-foreground">
                    {describeSpace({ name: space.name, kind: space.kind })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Référence des entrées et sorties — sans jauge propre
                  </span>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label={`Nom de la zone ${space.name}`}
                      value={space.name}
                      onChange={(e) => updateSpace(space.id, { name: e.target.value })}
                      className="w-full sm:flex-1"
                    />
                    <Input
                      type="number"
                      min="0"
                      aria-label={`Capacité de la zone ${space.name}`}
                      placeholder="Capacité"
                      value={space.capacity.capacity}
                      onChange={(e) =>
                        updateSpace(space.id, {
                          capacity: overrideCapacity(
                            space.capacity,
                            e.target.value === '' ? '' : parseInt(e.target.value, 10) || 0
                          ),
                        })
                      }
                      className="flex-1 font-mono sm:w-32 sm:flex-none"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Supprimer la zone ${space.name}`}
                      onClick={() => deleteSpace(space)}
                      disabled={save.kind === 'saving'}
                      className="shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => saveSpace(space)} disabled={save.kind === 'saving'}>
                      Enregistrer la zone
                    </Button>
                    {/* Linking is an explicit choice, never inferred from a
                        matching number or a familiar name. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => updateSpace(space.id, { capacity: relinkCapacity(capacity) })}
                      disabled={save.kind === 'saving'}
                    >
                      Même capacité que l’événement
                    </Button>
                  </div>
                </>
              )}
            </CardPanel>
          ))}
        </div>
      </Section>

      <Section
        title="Portes"
        actions={
          <Button variant="secondary" size="sm" onClick={addCheckpoint} disabled={save.kind === 'saving'}>
            <Plus className="size-3.5" /> Ajouter une porte
          </Button>
        }
      >
        <div className="space-y-3">
          {draft.checkpoints.map((checkpoint) => {
            const from = spaceOf(checkpoint.spaceAId);
            const to = spaceOf(checkpoint.spaceBId);
            return (
              <CardPanel key={checkpoint.id} className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={`Nom de la porte ${checkpoint.name}`}
                    value={checkpoint.name}
                    onChange={(e) => updateCheckpoint(checkpoint.id, { name: e.target.value })}
                    className="w-full sm:flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Supprimer la porte ${checkpoint.name}`}
                    onClick={() => deleteCheckpoint(checkpoint)}
                    disabled={save.kind === 'saving'}
                    className="shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 />
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Première zone</Label>
                    <NativeSelect
                      aria-label={`Première zone de la porte ${checkpoint.name}`}
                      value={checkpoint.spaceAId}
                      onChange={(e) => changeEndpoint(checkpoint, { spaceAId: e.target.value })}
                    >
                      {zonesForEndpoints.map((zone) => (
                        <option key={zone.id} value={zone.id}>
                          {zone.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Deuxième zone</Label>
                    <NativeSelect
                      aria-label={`Deuxième zone de la porte ${checkpoint.name}`}
                      value={checkpoint.spaceBId}
                      onChange={(e) => changeEndpoint(checkpoint, { spaceBId: e.target.value })}
                    >
                      {zonesForEndpoints.map((zone) => (
                        <option key={zone.id} value={zone.id}>
                          {zone.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                </div>

                {/* Directions read as the movement they are, never as A/B. */}
                <div className="space-y-2">
                  {(
                    [
                      { key: 'aToB' as const, from, to, allowed: checkpoint.allowAToB, label: checkpoint.labelAToB },
                      { key: 'bToA' as const, from: to, to: from, allowed: checkpoint.allowBToA, label: checkpoint.labelBToA },
                    ]
                  ).map((direction) => (
                    <div key={direction.key} className="space-y-1.5">
                      <div className="flex items-center gap-1">
                        <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
                          <input
                            type="checkbox"
                            className="size-5 accent-[var(--color-primary)]"
                            aria-label={`Autoriser ${describeDirection(direction.from, direction.to)}`}
                            checked={direction.allowed}
                            onChange={(e) =>
                              updateCheckpoint(
                                checkpoint.id,
                                direction.key === 'aToB'
                                  ? { allowAToB: e.target.checked }
                                  : { allowBToA: e.target.checked }
                              )
                            }
                          />
                        </label>
                        <span className="min-w-0 break-words text-xs font-semibold text-foreground">
                          {describeDirection(direction.from, direction.to)}
                        </span>
                      </div>
                      <Input
                        aria-label={`Libellé du bouton : ${describeDirection(direction.from, direction.to)}`}
                        value={direction.label.value}
                        disabled={!direction.allowed}
                        onChange={(e) =>
                          updateCheckpoint(
                            checkpoint.id,
                            direction.key === 'aToB'
                              ? { labelAToB: editedLabel(e.target.value) }
                              : { labelBToA: editedLabel(e.target.value) }
                          )
                        }
                      />
                    </div>
                  ))}
                </div>

                {!hasUsableDirections(checkpoint) ? (
                  <p className="text-xs font-semibold text-danger">
                    Une porte doit autoriser au moins un sens de passage.
                  </p>
                ) : null}

                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => saveCheckpoint(checkpoint)}
                  disabled={save.kind === 'saving' || !hasUsableDirections(checkpoint)}
                >
                  Enregistrer la porte
                </Button>
              </CardPanel>
            );
          })}
        </div>
      </Section>

      <Card className="space-y-3 p-4">
        {/* The verdict is the server's, quoted, not a local guess. */}
        <div data-testid="draft-preflight">
          {preflight.kind === 'ready' && preflight.data.ready ? (
            <Alert tone="success">
              <CheckCircle2 />
              <AlertDescription className="mt-0 text-foreground/90">
                Préparation complète : cet événement peut passer en direct.
              </AlertDescription>
            </Alert>
          ) : preflight.kind === 'ready' ? (
            <Alert tone="warning">
              <AlertCircle />
              <AlertDescription className="mt-0 text-foreground/90">
                {describePreflightError(preflight.data.error) || 'Cet événement n’est pas encore prêt à démarrer.'}
              </AlertDescription>
            </Alert>
          ) : preflight.kind === 'error' ? (
            <Alert tone="danger">
              <AlertCircle />
              <div className="min-w-0 flex-1">
                <AlertDescription className="mt-0 text-foreground/90">{preflight.detail}</AlertDescription>
                <Button variant="outline" size="sm" className="mt-2" onClick={reload}>
                  <RefreshCw className="size-3" /> Réessayer
                </Button>
              </div>
            </Alert>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">
          Le passage en direct reste sur l’écran de supervision.
        </p>
        <Button onClick={() => navigate(`/admin?event=${draft.event.id}`)}>Terminer la préparation</Button>
      </Card>
    </div>
  );
};
