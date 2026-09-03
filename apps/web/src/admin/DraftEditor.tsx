import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { apiFetch } from '../api/client.js';
import {
  CheckpointModel,
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
import { ConfirmAction } from '@/components/paxflux/confirm-action';
import { StatusBadge, eventStatusKey } from '@/components/paxflux/status';
import { TimezoneField } from './TimezoneField.js';
import {
  EditableCheckpoint,
  EditableSpace,
  applyEventCapacity,
  defaultDirectionLabel,
  describeDirection,
  describePreflightError,
  describeSpace,
  editedLabel,
  hasEditableCapacity,
  hasUsableDirections,
  overrideCapacity,
  reconcileCheckpoints,
  reconcileField,
  reconcileSpaces,
  relabelForEndpoints,
  relinkCapacity,
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

  /**
   * What the server said on the previous load.
   *
   * A reload has to show what persisted without discarding what is still
   * being typed elsewhere, and telling those apart needs a reference point:
   * a field still equal to this is one nobody has edited since. In a ref
   * rather than state because it is never rendered — only compared against.
   */
  const lastServerRef = useRef<EventDetailResponse | null>(null);

  /**
   * Doors this screen created, whose labels it generated.
   *
   * The POST that creates one is followed by a reload, at which point the
   * row is new to the merge. Without this it would be adopted as the
   * operator's own wording and stop following its zones. Provenance is
   * recorded from the act of generating, never guessed from the text.
   */
  const generatedLabelIdsRef = useRef<Set<string>>(new Set());

  const { user } = useAuth();
  const isAdmin = user.role === 'admin';

  // Event fields are edited locally and committed explicitly, so a slow
  // keystroke never races a request.
  const [name, setName] = useState('');
  const [capacity, setCapacityState] = useState(0);
  const [timezone, setTimezone] = useState('');
  /**
   * The timezone as the server last reported it.
   *
   * Used to tell an edit from a resend. Events created before the IANA rule
   * could store `GMT`, `EST` or any 1–50 character string; such a value is
   * loaded and kept exactly, and only a *change* has to be a real zone.
   */
  const [storedTimezone, setStoredTimezone] = useState('');

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
      const previous = lastServerRef.current;

      setDraft((current) =>
        previous && current
          ? {
              event: detail.event,
              spaces: reconcileSpaces(previous.spaces, current.spaces, detail.spaces),
              checkpoints: reconcileCheckpoints(
                previous.checkpoints,
                current.checkpoints,
                detail.checkpoints,
                generatedLabelIdsRef.current
              ),
            }
          : {
              event: detail.event,
              spaces: toEditableSpaces(detail.spaces),
              checkpoints: reconcileCheckpoints([], [], detail.checkpoints, generatedLabelIdsRef.current),
            }
      );
      setName((local) => (previous ? reconcileField(previous.event.name, local, detail.event.name) : detail.event.name));
      setCapacityState((local) =>
        previous ? reconcileField(previous.event.capacity, local, detail.event.capacity) : detail.event.capacity
      );
      setTimezone((local) =>
        previous ? reconcileField(previous.event.timezone, local, detail.event.timezone) : detail.event.timezone
      );
      setStoredTimezone(detail.event.timezone);

      lastServerRef.current = detail;
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

  // Each save normalises the field locally to exactly what it sends. The
  // reload that follows then agrees with the server about the saved entity —
  // the merge above has nothing to disagree about — while still protecting
  // whatever is being typed in the other sections.
  const saveEvent = () => {
    const trimmed = name.trim();
    setName(trimmed);
    return mutate(() =>
      apiFetch(`/api/v1/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: trimmed,
          capacity,
          // Sent only when it actually changed. An event created before the
          // IANA rule existed may hold something the current validator
          // rejects; resending it would make that event permanently
          // uneditable, and rewriting it silently would be worse.
          ...(timezone === storedTimezone ? {} : { timezone }),
          // The precondition, checked server-side inside the transaction
          // that writes. This screen may have been open for minutes; the
          // generic route legitimately allows a *live* event's name and
          // capacity to change, and nothing from a stale draft editor may
          // ride in on that.
          expectedStatus: 'draft',
        }),
      })
    );
  };

  const saveSpace = (space: EditableSpace) => {
    const trimmed = space.name.trim();
    updateSpace(space.id, { name: trimmed });
    return mutate(() =>
      apiFetch(`/api/v1/events/${eventId}/spaces/${space.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: trimmed,
          ...(hasEditableCapacity(space)
            ? { capacity: space.capacity.capacity === '' ? null : space.capacity.capacity }
            : {}),
        }),
      })
    );
  };

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

  const saveCheckpoint = (checkpoint: EditableCheckpoint) => {
    const name = checkpoint.name.trim();
    const labelAToB = checkpoint.labelAToB.value.trim();
    const labelBToA = checkpoint.labelBToA.value.trim();
    updateCheckpoint(checkpoint.id, {
      name,
      labelAToB: { ...checkpoint.labelAToB, value: labelAToB },
      labelBToA: { ...checkpoint.labelBToA, value: labelBToA },
    });

    return mutate(() =>
      apiFetch(`/api/v1/events/${eventId}/checkpoints/${checkpoint.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          spaceAId: checkpoint.spaceAId,
          spaceBId: checkpoint.spaceBId,
          allowAToB: checkpoint.allowAToB,
          allowBToA: checkpoint.allowBToA,
          labelAToB,
          labelBToA,
        }),
      })
    );
  };

  const addCheckpoint = () => {
    const zones = draft?.spaces.filter((s) => s.kind !== 'aggregate') ?? [];
    const first = zones.find((s) => s.kind === 'external') ?? zones[0];
    const second = zones.find((s) => s.id !== first?.id);

    // A door connects two zones; with fewer than two there is nothing to
    // connect. Saying so beats a button that appears to work and does
    // nothing.
    if (!first || !second) {
      setSave({
        kind: 'failed',
        detail: 'Une porte relie deux zones : ajoutez d’abord une zone intérieure.',
      });
      return Promise.resolve(false);
    }

    return mutate(async () => {
      const created = await apiFetch<CheckpointModel>(`/api/v1/events/${eventId}/checkpoints`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Nouvelle porte',
          spaceAId: first.id,
          spaceBId: second.id,
          allowAToB: true,
          allowBToA: true,
          // Generated from the zones it actually connects, so an internal
          // door does not claim to be an "entrée".
          labelAToB: defaultDirectionLabel(first, second),
          labelBToA: defaultDirectionLabel(second, first),
          sortOrder: (draft?.checkpoints.length ?? 0) + 1,
        }),
      });
      // Remembered before the reload that follows, which is the moment the
      // provenance would otherwise be lost.
      generatedLabelIdsRef.current.add(created.id);
      return created;
    });
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

  // Every mutation this screen makes requires the admin role server-side.
  // Showing a supervisor the form would be showing them a screen where each
  // save comes back 403 — a half-working editor is worse than none.
  if (!isAdmin) {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 p-4 sm:p-6">
        <PageHeader title="Préparation réservée aux administrateurs" />
        <Alert tone="warning">
          <AlertCircle />
          <div className="min-w-0">
            <AlertTitle>Modification réservée aux administrateurs</AlertTitle>
            <AlertDescription>
              La préparation d’un événement — zones, portes, capacités — ne peut être modifiée que par un compte
              administrateur. La supervision de l’événement reste accessible.
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

  // The editor is for preparation. Once an event is live its topology is
  // locked server-side, and pretending otherwise would invite an operator to
  // type changes that can only be refused.
  if (draft.event.status !== 'draft') {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 p-4 sm:p-6">
        <PageHeader title="Préparation verrouillée" />
        {/* If a save is what brought us here, say so. Converging silently to
            a lock screen leaves the operator to guess whether the thing they
            just typed went through; it did not, and that is the first thing
            they need to know. */}
        <div aria-live="polite" data-testid="draft-save-state">
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
            <TimezoneField value={timezone} onChange={setTimezone} storedValue={storedTimezone} />
          </div>

          <Button
            onClick={saveEvent}
            disabled={
              save.kind === 'saving' ||
              name.trim().length === 0 ||
              // Only a *changed* timezone has to be valid: a legacy value
              // left alone is not this save's business.
              (timezone !== storedTimezone && !isValidTimezone(timezone))
            }
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
                    {/* An aggregate zone's occupancy is the sum of its
                        children, so it has no capacity of its own to type —
                        and `saveSpace` would not send one. Showing the field
                        anyway would be a control that quietly does nothing. */}
                    {hasEditableCapacity(space) ? (
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
                    ) : null}
                    {/* Deleting a zone is not undoable from this screen, so
                        it asks first — through the same dialog the lifecycle
                        transitions use. Cancelling sends nothing. */}
                    <ConfirmAction
                      disabled={save.kind === 'saving'}
                      busy={save.kind === 'saving'}
                      title={`Supprimer la zone « ${space.name} » ?`}
                      description="Cette zone et sa jauge disparaissent de la préparation. Une zone encore reliée à une porte ne peut pas être supprimée."
                      confirmLabel="Supprimer la zone"
                      confirmVariant="destructive"
                      onConfirm={async () => {
                        await deleteSpace(space);
                      }}
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Supprimer la zone ${space.name}`}
                          disabled={save.kind === 'saving'}
                          className="shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
                        >
                          <Trash2 />
                        </Button>
                      }
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => saveSpace(space)} disabled={save.kind === 'saving'}>
                      Enregistrer la zone
                    </Button>
                    {/* Linking is an explicit choice, never inferred from a
                        matching number or a familiar name. */}
                    {hasEditableCapacity(space) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => updateSpace(space.id, { capacity: relinkCapacity(capacity) })}
                        disabled={save.kind === 'saving'}
                      >
                        Même capacité que l’événement
                      </Button>
                    ) : null}
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
              // Addressable per door: two doors between the same pair of
              // zones legitimately carry the same direction wording, so a
              // test (or an assistive technology) needs the row itself.
              <CardPanel key={checkpoint.id} data-testid={`checkpoint-${checkpoint.id}`} className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={`Nom de la porte ${checkpoint.name}`}
                    value={checkpoint.name}
                    onChange={(e) => updateCheckpoint(checkpoint.id, { name: e.target.value })}
                    className="w-full sm:flex-1"
                  />
                  <ConfirmAction
                    disabled={save.kind === 'saving'}
                    busy={save.kind === 'saving'}
                    title={`Supprimer la porte « ${checkpoint.name} » ?`}
                    description="Cette porte et les invitations QR émises pour elle disparaissent de la préparation. Une porte à laquelle un appareil est appairé ne peut pas être supprimée."
                    confirmLabel="Supprimer la porte"
                    confirmVariant="destructive"
                    onConfirm={async () => {
                      await deleteCheckpoint(checkpoint);
                    }}
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Supprimer la porte ${checkpoint.name}`}
                        disabled={save.kind === 'saving'}
                        className="shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 />
                      </Button>
                    }
                  />
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
