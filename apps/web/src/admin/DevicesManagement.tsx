import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { QRCodeSVG } from 'qrcode.react';
import { QrCode, CheckCircle, AlertCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import {
  CreateDeviceInviteResponse,
  CheckpointModel,
  EventDeviceSummary,
  ProblemDetails,
  DEVICE_LABEL_MAX_LENGTH,
  RenameDeviceResponse,
} from '@paxflux/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CardPanel } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  TableScroller,
} from '@/components/ui/table';
import { ConfirmAction, RenameAction } from '@/components/paxflux/confirm-action';
import { PageHeader, Section } from '@/components/paxflux/layout';
import { StatusText } from '@/components/paxflux/status';

const DEVICES_POLL_INTERVAL_MS = 5_000;

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; devices: EventDeviceSummary[]; checkpoints: CheckpointModel[] }
  | { kind: 'error'; detail: string };

function errorDetail(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'detail' in err) {
    return String((err as ProblemDetails).detail);
  }
  return fallback;
}

function formatLastSeen(lastSeenAtMs: number | null): string {
  if (!lastSeenAtMs) return '—';
  return new Date(lastSeenAtMs).toLocaleTimeString('fr-FR');
}

export const DevicesManagement: React.FC = () => {
  const { id: eventId } = useParams<{ id: string }>();
  const [listState, setListState] = useState<ListState>({ kind: 'loading' });
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string>('');
  const [activeInvite, setActiveInvite] = useState<CreateDeviceInviteResponse | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // `silent` (background polling, or a manual refresh with a list already
  // on screen) keeps the current rows visible instead of flashing back to a
  // skeleton, and never replaces good data with a transient fetch error.
  const fetchDevices = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!eventId) return;
      if (!opts.silent) setListState({ kind: 'loading' });
      setRefreshing(true);
      try {
        const [devList, cpList] = await Promise.all([
          apiFetch<EventDeviceSummary[]>(`/api/v1/events/${eventId}/devices`),
          apiFetch<CheckpointModel[]>(`/api/v1/events/${eventId}/checkpoints`),
        ]);
        setListState({ kind: 'ready', devices: devList, checkpoints: cpList });
        setSelectedCheckpointId((current) =>
          current && cpList.some((cp) => cp.id === current) ? current : cpList[0]?.id || ''
        );
      } catch (err) {
        setListState((prev) =>
          opts.silent && prev.kind === 'ready'
            ? prev
            : { kind: 'error', detail: errorDetail(err, 'Impossible de charger les appareils de cet événement.') }
        );
      } finally {
        setRefreshing(false);
      }
    },
    [eventId]
  );

  // A device goes online or drains its outbox entirely on its own — nothing
  // the admin does here triggers a re-render. Poll while this page is open
  // so the list is current without a manual reload. One request at a time:
  // each tick waits for the previous fetch before scheduling the next.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (silent: boolean) => {
      await fetchDevices({ silent });
      if (!cancelled) {
        timer = setTimeout(() => tick(true), DEVICES_POLL_INTERVAL_MS);
      }
    };

    tick(false);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchDevices]);

  const handleCreateInvite = async () => {
    if (!eventId || !selectedCheckpointId) return;
    setCreating(true);
    setActionError(null);
    try {
      // The pairing URL comes from the server (PUBLIC_BASE_URL, or the
      // request origin) and is used exactly as returned. Rebuilding it from
      // window.location would encode whatever origin the admin happens to
      // be browsing — typically localhost — into a QR meant for a phone.
      const invite = await apiFetch<CreateDeviceInviteResponse>(`/api/v1/events/${eventId}/device-invites`, {
        method: 'POST',
        body: JSON.stringify({
          checkpointId: selectedCheckpointId,
          expiresInMinutes: 30,
        }),
      });
      setActiveInvite(invite);
    } catch (err) {
      setActiveInvite(null);
      setActionError(errorDetail(err, 'Impossible de générer le QR code d’appairage.'));
    } finally {
      setCreating(false);
    }
  };

  // Reached only from a confirmed dialog. Revocation used to sit behind a
  // `window.confirm`, which on an installed PWA renders as an unbranded
  // system sheet naming the origin — and which Playwright dismisses by
  // default, so the path was effectively untested.
  /**
   * Renames one device through the real API, then converges on the server.
   *
   * `silent` refresh so the table does not flash back to a loading skeleton
   * for a one-field change, and so the QR panel currently on screen is not
   * torn down because a row was renamed. Returns whether it succeeded: the
   * dialog stays open on a refusal so the name can be corrected in place.
   */
  const handleRenameDevice = async (sessionId: string, label: string): Promise<boolean> => {
    setRenameError(null);
    try {
      await apiFetch<RenameDeviceResponse>(`/api/v1/device-sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ label }),
      });
      await fetchDevices({ silent: true });
      return true;
    } catch (err) {
      setRenameError(errorDetail(err, 'Ce nom n’a pas pu être enregistré.'));
      return false;
    }
  };

  const handleRevokeDevice = async (sessionId: string) => {
    setActionError(null);
    try {
      await apiFetch(`/api/v1/device-sessions/${sessionId}/revoke`, { method: 'POST' });
      await fetchDevices({ silent: true });
    } catch (err) {
      setActionError(errorDetail(err, 'Impossible de révoquer cet appareil.'));
    }
  };

  const devices = listState.kind === 'ready' ? listState.devices : [];
  const checkpoints = listState.kind === 'ready' ? listState.checkpoints : [];

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 space-y-4 p-4 sm:space-y-6 sm:p-6">
      <PageHeader title="Gestion des Appareils et QR Codes" />

      {actionError ? (
        <Alert tone="danger">
          <AlertCircle />
          <AlertDescription className="mt-0 text-foreground/90">{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <Section title="Ajouter un Appareil Compteur">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="w-full flex-1 space-y-1.5">
            <Label htmlFor="checkpoint-picker">Choisir la porte / le checkpoint :</Label>
            <NativeSelect
              id="checkpoint-picker"
              value={selectedCheckpointId}
              onChange={(e) => setSelectedCheckpointId(e.target.value)}
            >
              {checkpoints.map((cp) => (
                <option key={cp.id} value={cp.id}>
                  {cp.name}
                </option>
              ))}
            </NativeSelect>
          </div>

          <Button
            className="w-full sm:w-auto"
            disabled={creating || !selectedCheckpointId}
            onClick={handleCreateInvite}
          >
            <QrCode />
            Générer le QR Code d'appairage
          </Button>
        </div>

        {/* The 180px code keeps its size — smaller scans badly — so the
            panel's own padding is what gives way at 320px, and the text
            column shrinks beside it. */}
        {activeInvite ? (
          <CardPanel className="mt-6 flex flex-col items-center gap-4 border-primary-accent/40 p-4 sm:gap-6 sm:p-6 md:flex-row">
            {/* The only literal colour left in the admin interface: a QR
                code is only reliably scannable as dark-on-white, whatever
                the surrounding theme. */}
            <div className="shrink-0 rounded-lg bg-white p-3 sm:p-4">
              <QRCodeSVG value={activeInvite.pairUrl} size={180} level="M" />
            </div>

            <div className="w-full min-w-0 flex-1 space-y-3 text-center md:text-left">
              <Badge tone="success">
                <CheckCircle />
                QR Code Prêt pour scan
              </Badge>
              <p className="text-sm font-bold text-foreground">
                Scannez ce QR Code avec l'appareil photo du téléphone.
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Le secret d'appairage est transmis dans le fragment URL et ne sera pas stocké dans les logs
                serveur. Valable 30 minutes, à usage unique.
              </p>

              {activeInvite.unreachableFromPhone ? (
                <Alert tone="warning" className="text-left">
                  <AlertTriangle />
                  <AlertDescription className="mt-0 text-foreground/90">
                    Cette URL pointe vers une adresse locale à ce serveur : un téléphone ne pourra pas
                    l'ouvrir. Configurez <span className="font-mono">PUBLIC_BASE_URL</span>, ou ouvrez
                    PaxFlux via l'adresse réseau que les téléphones peuvent joindre.
                  </AlertDescription>
                </Alert>
              ) : null}

              {/* Judged on the URL the phone actually receives, not on
                  whether PUBLIC_BASE_URL happens to be set. Pairing is not
                  blocked: it works over plain HTTP and refusing it would
                  help nobody. What does not work is everything that makes
                  this an installed counter — service workers, and so the
                  offline outbox, need a secure context, which browsers grant
                  to HTTPS and to loopback but never to a LAN IP over HTTP.
                  Saying so here is the difference between an operator
                  choosing to accept that and discovering it at the door. */}
              {activeInvite.insecureForInstall ? (
                <Alert tone="warning" className="text-left" data-testid="pairing-insecure-context">
                  <AlertTriangle />
                  <AlertDescription className="mt-0 text-foreground/90">
                    L’appairage peut fonctionner en HTTP, mais l’installation de l’application et le mode hors
                    ligne nécessitent HTTPS sur un téléphone. Sur cette adresse, «&nbsp;Ajouter à l’écran
                    d’accueil&nbsp;» créera un raccourci, pas une application installée.
                  </AlertDescription>
                </Alert>
              ) : null}

              <p className="select-all break-all rounded-lg border border-border bg-background p-2.5 font-mono text-[11px] text-muted-foreground">
                {activeInvite.pairUrl}
              </p>
            </div>
          </CardPanel>
        ) : null}
      </Section>

      <Section
        title={`Appareils Enregistrés (${devices.length})`}
        contentClassName="p-0 sm:p-0"
        actions={
          <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => fetchDevices({ silent: true })}>
            <RefreshCw className={refreshing ? 'size-3 animate-spin' : 'size-3'} /> Actualiser
          </Button>
        }
      >
        {listState.kind === 'loading' ? (
          <p className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
            <RefreshCw className="size-3.5 animate-spin" /> Chargement des appareils…
          </p>
        ) : listState.kind === 'error' ? (
          <Alert tone="danger" className="mx-4 mb-4">
            <AlertCircle />
            <div className="min-w-0 flex-1">
              <AlertDescription className="mt-0 text-foreground/90">{listState.detail}</AlertDescription>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => fetchDevices()}>
                <RefreshCw className="size-3" /> Réessayer
              </Button>
            </div>
          </Alert>
        ) : (
          /* Six columns of device state stay in their own scroll area
             rather than widening the page. */
          <TableScroller className="px-1 pb-4" minWidth="42rem">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Porte</TableHead>
                  <TableHead>Libellé</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead>En attente</TableHead>
                  <TableHead>Dernier Contact</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((dev) => (
                  <TableRow key={dev.id}>
                    <TableCell className="font-medium text-foreground">{dev.checkpointName}</TableCell>
                    <TableCell>{dev.label}</TableCell>
                    <TableCell>
                      {/* isOnline is computed server-side against the shared
                          threshold, so this matches what the closing gate
                          sees rather than a second frontend approximation. */}
                      <StatusText status={dev.isOnline ? 'online' : 'offline'} />
                    </TableCell>
                    <TableCell className="font-mono">
                      {dev.lastPendingCount > 0 ? (
                        <span className="font-semibold text-warning">{dev.lastPendingCount}</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">
                      {formatLastSeen(dev.lastSeenAtMs)}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* Two actions on one row: renaming is routine, so it
                          is the quiet one; revoking is not. */}
                      <div className="flex items-center justify-end gap-2">
                        <RenameAction
                          title="Renommer cet appareil"
                          description={`Ce nom identifie le téléphone, pas la porte « ${dev.checkpointName} ».`}
                          fieldLabel="Nom de l’appareil"
                          currentValue={dev.label}
                          maxLength={DEVICE_LABEL_MAX_LENGTH}
                          placeholder="Ex : téléphone entrée nord"
                          confirmLabel="Enregistrer le nom"
                          errorMessage={renameError}
                          onRename={(label) => handleRenameDevice(dev.id, label)}
                          trigger={
                            <Button variant="secondary" size="sm" aria-label={`Renommer ${dev.label}`}>
                              Renommer
                            </Button>
                          }
                        />
                      <ConfirmAction
                        title="Révoquer cet appareil ?"
                        description={`« ${dev.label} » (${dev.checkpointName}) ne pourra plus envoyer de comptages. Les comptages qu'il détient encore devront être régularisés par un responsable.`}
                        confirmLabel="Révoquer l'appareil"
                        confirmVariant="destructive"
                        onConfirm={() => handleRevokeDevice(dev.id)}
                        trigger={
                          <Button variant="danger" size="sm">
                            Révoquer
                          </Button>
                        }
                      />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {devices.length === 0 ? (
                  <TableEmpty colSpan={6}>Aucun appareil connecté.</TableEmpty>
                ) : null}
              </TableBody>
            </Table>
          </TableScroller>
        )}
      </Section>
    </div>
  );
};
