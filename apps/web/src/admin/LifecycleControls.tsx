import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import { EventDetailResponse, EventModel, ProblemDetails, PreflightResponse } from '@paxflux/shared';
import {
  PlayCircle,
  Lock,
  XCircle,
  AlertTriangle,
  CheckCircle,
  Loader2,
  RefreshCw,
  RotateCcw,
  Archive,
  Pencil,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CardPanel } from '@/components/ui/card';
import { ConfirmAction, ReasonAction } from '@/components/paxflux/confirm-action';
import { StatusText } from '@/components/paxflux/status';
import { describePreflightError } from './draft-form.js';

type DeviceRow = EventDetailResponse['devices'][number];

interface LifecycleControlsProps {
  event: EventModel;
  onChanged: () => void;
}

function errorDetail(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'detail' in err) {
    return String((err as ProblemDetails).detail);
  }
  return fallback;
}

type PreflightState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PreflightResponse }
  | { kind: 'error'; detail: string };

type DevicesState =
  | { kind: 'loading' }
  | { kind: 'ready'; devices: DeviceRow[] }
  | { kind: 'error'; detail: string };

const DEVICES_POLL_INTERVAL_MS = 3_000;

/**
 * Lifecycle surface: draft -> live -> closing -> closed -> archived, plus
 * the admin-only closed -> live reopen. Each transition calls the
 * corresponding server endpoint directly — the server is the sole source of
 * truth for whether a transition is valid (see
 * apps/server/src/domain/events.ts). This component only decides which
 * actions make sense for the current status and asks for confirmation (and,
 * for the two audited actions, a reason) before calling them.
 *
 * Those confirmations used to be `window.confirm` and `window.prompt`. They
 * are now real dialogs (`components/paxflux/confirm-action`), which changes
 * three things and no more: force-close can be shown as dangerous rather
 * than described as such in a system font; the reason is validated while it
 * is being typed instead of after a second modal; and the two-step
 * prompt-then-confirm for force-close and reopen becomes one step. The
 * endpoints, the payloads, the reason's minimum length and the rule that a
 * cancelled confirmation sends nothing are all unchanged.
 */
export const LifecycleControls: React.FC<LifecycleControlsProps> = ({ event, onChanged }) => {
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';

  const [preflight, setPreflight] = useState<PreflightState>({ kind: 'loading' });
  const [devicesState, setDevicesState] = useState<DevicesState>({ kind: 'loading' });
  const [devicesRefreshing, setDevicesRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshPreflight = useCallback(async () => {
    if (event.status !== 'draft') return;
    setPreflight({ kind: 'loading' });
    try {
      const res = await apiFetch<PreflightResponse>(`/api/v1/events/${event.id}/preflight`);
      setPreflight({ kind: 'ready', data: res });
    } catch (err) {
      setPreflight({ kind: 'error', detail: errorDetail(err, 'Impossible de vérifier le préflight.') });
    }
  }, [event.id, event.status]);

  useEffect(() => {
    refreshPreflight();
  }, [refreshPreflight]);

  // Refreshes the device list. `silent` (background polling, or a manual
  // "Actualiser" click while a list is already showing) keeps the current
  // list on screen instead of flashing back to a loading skeleton, and
  // never clobbers good data with a transient fetch error.
  const refreshDevices = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (event.status !== 'closing') return;
      if (!opts.silent) {
        setDevicesState({ kind: 'loading' });
      }
      setDevicesRefreshing(true);
      try {
        const res = await apiFetch<DeviceRow[]>(`/api/v1/events/${event.id}/devices`);
        setDevicesState({ kind: 'ready', devices: res });
      } catch (err) {
        setDevicesState((prev) =>
          opts.silent && prev.kind === 'ready'
            ? prev
            : { kind: 'error', detail: errorDetail(err, 'Impossible de charger la liste des appareils.') }
        );
      } finally {
        setDevicesRefreshing(false);
      }
    },
    [event.id, event.status]
  );

  // While closing, an appareil can go from offline/pending to fully synced
  // entirely on its own (it reconnects and drains its outbox) — nothing the
  // admin does triggers a re-render. Poll every few seconds so the device
  // list and the normal-close button's enabled state stay current without a
  // manual reload. A single in-flight request at a time: each tick waits for
  // the previous fetch to resolve before scheduling the next, so a slow
  // response never queues up parallel requests.
  useEffect(() => {
    if (event.status !== 'closing') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (silent: boolean) => {
      await refreshDevices({ silent });
      if (!cancelled) {
        timer = setTimeout(() => tick(true), DEVICES_POLL_INTERVAL_MS);
      }
    };

    tick(false);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [event.status, refreshDevices]);

  /**
   * The only path from a confirmation to a request. Reaching it means the
   * operator confirmed; cancelling never gets here.
   */
  const runTransition = useCallback(
    async (path: string, body?: Record<string, unknown>) => {
      setActionLoading(true);
      setActionError(null);
      try {
        await apiFetch(`/api/v1/events/${event.id}/${path}`, {
          method: 'POST',
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        onChanged();
      } catch (err) {
        setActionError(errorDetail(err, 'Une erreur est survenue.'));
      } finally {
        setActionLoading(false);
      }
    },
    [event.id, onChanged]
  );

  const errorBanner = actionError ? (
    <Alert tone="danger">
      <AlertTriangle />
      <AlertDescription className="mt-0 text-foreground/90">{actionError}</AlertDescription>
    </Alert>
  ) : null;

  if (event.status === 'draft') {
    const ready = preflight.kind === 'ready' && preflight.data.ready;
    return (
      <div className="space-y-3">
        {preflight.kind === 'loading' ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Vérification du préflight…
          </p>
        ) : preflight.kind === 'error' ? (
          <Alert tone="danger">
            <AlertTriangle />
            <div className="min-w-0 flex-1">
              <AlertDescription className="mt-0 text-foreground/90">{preflight.detail}</AlertDescription>
              <Button variant="outline" size="sm" className="mt-2" onClick={refreshPreflight}>
                <RefreshCw className="size-3" /> Réessayer
              </Button>
            </div>
          </Alert>
        ) : !preflight.data.ready ? (
          <Alert tone="warning">
            <AlertTriangle />
            <AlertDescription className="mt-0 text-foreground/90">
              {describePreflightError(preflight.data.error) || "Cet événement n'est pas prêt à démarrer."}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert tone="success">
            <CheckCircle />
            <AlertDescription className="mt-0 text-foreground/90">
              Topologie valide. Prêt à démarrer.
            </AlertDescription>
          </Alert>
        )}

        {errorBanner}

        {/* Preparation is editable right up to the moment the event starts,
            and a preflight refusal is only actionable if the screen that
            fixes it is one tap away. This link exists only in `draft`: past
            that, the topology is locked server-side and offering to edit it
            would be a lie. */}
        <Button asChild variant="secondary" className="w-full sm:w-auto sm:min-w-56">
          <Link to={`/admin/events/${event.id}/edit`}>
            <Pencil />
            Modifier le brouillon
          </Link>
        </Button>

        <ConfirmAction
          disabled={actionLoading || !ready}
          busy={actionLoading}
          title="Démarrer l'événement ?"
          description="L'événement passe en direct et les compteurs sur le terrain commencent à accepter des comptages."
          confirmLabel="Démarrer l'événement"
          confirmVariant="success"
          onConfirm={() => runTransition('start')}
          trigger={
            <Button variant="success" className="w-full sm:w-auto sm:min-w-56" disabled={actionLoading || !ready}>
              {actionLoading ? <Loader2 className="animate-spin" /> : <PlayCircle />}
              Démarrer l'événement
            </Button>
          }
        />
      </div>
    );
  }

  if (event.status === 'live') {
    return (
      <div className="space-y-3">
        {errorBanner}
        <ConfirmAction
          disabled={actionLoading}
          busy={actionLoading}
          title="Débuter la fermeture ?"
          description="Les compteurs sur le terrain n'accepteront plus de nouveaux comptages. Ceux déjà enregistrés hors ligne continueront d'être drainés."
          confirmLabel="Débuter la fermeture"
          confirmVariant="closing"
          onConfirm={() => runTransition('begin-closing')}
          trigger={
            <Button variant="closing" className="w-full sm:w-auto sm:min-w-56" disabled={actionLoading}>
              {actionLoading ? <Loader2 className="animate-spin" /> : <Lock />}
              Débuter la fermeture
            </Button>
          }
        />
      </div>
    );
  }

  if (event.status === 'closing') {
    const allSynced =
      devicesState.kind === 'ready' &&
      devicesState.devices.every((d) => d.isOnline && d.lastPendingCount === 0);

    return (
      <div className="space-y-3">
        {errorBanner}

        {devicesState.kind === 'loading' ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Chargement des appareils…
          </p>
        ) : devicesState.kind === 'error' ? (
          <Alert tone="danger">
            <AlertTriangle />
            <div className="min-w-0 flex-1">
              <AlertDescription className="mt-0 text-foreground/90">{devicesState.detail}</AlertDescription>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => refreshDevices()}>
                <RefreshCw className="size-3" /> Réessayer
              </Button>
            </div>
          </Alert>
        ) : (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Appareils actifs — mise à jour automatique
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={devicesRefreshing}
                onClick={() => refreshDevices({ silent: true })}
              >
                <RefreshCw className={devicesRefreshing ? 'size-3 animate-spin' : 'size-3'} /> Actualiser
              </Button>
            </div>

            {devicesState.devices.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucun appareil actif pour cet événement.</p>
            ) : (
              devicesState.devices.map((d) => (
                <CardPanel
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs"
                >
                  <span className="min-w-0 break-words font-semibold text-foreground/90">
                    {d.checkpointName} — {d.label}
                  </span>
                  <span className="flex items-center gap-2.5">
                    <StatusText status={d.isOnline ? 'online' : 'offline'} />
                    {d.lastPendingCount > 0 ? (
                      <span className="font-semibold text-warning">{d.lastPendingCount} en attente</span>
                    ) : null}
                  </span>
                </CardPanel>
              ))
            )}
          </div>
        )}

        {devicesState.kind === 'ready' && !allSynced ? (
          <p className="text-[11px] text-warning">
            La fermeture normale nécessite que tous les appareils actifs soient en ligne et synchronisés (0
            en attente).
          </p>
        ) : null}

        <ConfirmAction
          disabled={actionLoading || !allSynced}
          busy={actionLoading}
          title="Clôturer l'événement ?"
          description="Tous les appareils actifs sont synchronisés. La jauge finale sera figée et le comptage définitivement arrêté."
          confirmLabel="Clôturer l'événement"
          confirmVariant="destructive"
          onConfirm={() => runTransition('close')}
          trigger={
            <Button variant="destructive" className="w-full sm:w-auto sm:min-w-56" disabled={actionLoading || !allSynced}>
              {actionLoading ? <Loader2 className="animate-spin" /> : <XCircle />}
              Clôturer l'événement
            </Button>
          }
        />

        {isAdmin ? (
          <ReasonAction
            disabled={actionLoading}
            busy={actionLoading}
            title="Fermeture forcée"
            description="Cette clôture ignore des appareils potentiellement non synchronisés : les comptages qu'ils détiennent encore ne seront pas intégrés à la jauge finale. Le motif est obligatoire et conservé dans le journal d'audit."
            confirmLabel="Confirmer la fermeture forcée"
            confirmVariant="danger"
            reasonLabel="Motif de la fermeture forcée *"
            reasonPlaceholder="Ex : appareil perdu, porte 3"
            onConfirm={(reason) => runTransition('force-close', { reason })}
            trigger={
              <Button variant="danger" size="sm" className="w-full sm:w-auto sm:min-w-56" disabled={actionLoading}>
                <AlertTriangle className="size-3.5" />
                Fermeture forcée (admin)
              </Button>
            }
          />
        ) : null}
      </div>
    );
  }

  if (event.status === 'closed') {
    if (!isAdmin) {
      return (
        <p className="text-xs text-muted-foreground">
          Événement clos. Seul un administrateur peut le réouvrir ou l'archiver.
        </p>
      );
    }

    return (
      <div className="space-y-3">
        {errorBanner}
        <ReasonAction
          disabled={actionLoading}
          busy={actionLoading}
          title="Réouvrir l'événement clos ?"
          description="L'événement repasse en direct et les compteurs recommencent à accepter des comptages. Le motif est obligatoire et conservé dans le journal d'audit."
          confirmLabel="Réouvrir l'événement"
          confirmVariant="default"
          reasonLabel="Motif de la réouverture *"
          reasonPlaceholder="Ex : clôture anticipée par erreur"
          onConfirm={(reason) => runTransition('reopen', { reason })}
          trigger={
            <Button className="w-full sm:w-auto sm:min-w-56" disabled={actionLoading}>
              {actionLoading ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              Réouvrir l'événement
            </Button>
          }
        />
        <ConfirmAction
          disabled={actionLoading}
          busy={actionLoading}
          title="Archiver l'événement ?"
          description="Cette action est terminale : l'événement passe en lecture seule et ne pourra plus être réouvert."
          confirmLabel="Archiver l'événement"
          confirmVariant="destructive"
          onConfirm={() => runTransition('archive')}
          trigger={
            <Button variant="secondary" className="w-full sm:w-auto sm:min-w-56" disabled={actionLoading}>
              {actionLoading ? <Loader2 className="animate-spin" /> : <Archive />}
              Archiver l'événement
            </Button>
          }
        />
      </div>
    );
  }

  if (event.status === 'archived') {
    return <p className="text-xs text-muted-foreground">Événement archivé — lecture seule.</p>;
  }

  return (
    <p className="text-xs text-muted-foreground">
      Aucune action de cycle de vie disponible pour cet état ({event.status}).
    </p>
  );
};
