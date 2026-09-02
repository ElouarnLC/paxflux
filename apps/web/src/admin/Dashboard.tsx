import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { useSSE } from '../sse/useSSE.js';
import { LifecycleControls } from './LifecycleControls.js';
import {
  EventDetailResponse,
  EventModel,
  SpaceModel,
  CompactEventState,
} from '@paxflux/shared';
import {
  DashboardView,
  acceptSupervisionResponse,
  applyLifecycleMessage,
  applyLiveState,
  isLifecyclePushForEvent,
  summariseSyncQuality,
} from './supervision.js';
import {
  Users,
  Activity,
  QrCode,
  Download,
  Plus,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardPanel } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/native-select';
import { Progress } from '@/components/ui/progress';
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
import { EmptyState, Section } from '@/components/paxflux/layout';
import {
  STATUS,
  StatusBadge,
  StatusText,
  eventStatusKey,
} from '@/components/paxflux/status';

/**
 * How often the supervision half of the dashboard is re-read from the server.
 *
 * A device goes offline when its heartbeat *stops*, and silence produces no
 * SSE frame — so nothing pushes that transition to this screen. The server
 * calls a device offline after `DEVICE_OFFLINE_THRESHOLD_MS` (45s) of
 * silence; re-reading `/state` every few seconds keeps the dashboard's
 * verdict within a few seconds of the device-management screen's, which is
 * what an operator compares it against.
 *
 * Deliberately not faster: `/state` is a handful of indexed reads, but it is
 * still a request per supervisor per tick, and nothing on this card changes
 * meaningfully inside five seconds.
 */
const SUPERVISION_POLL_INTERVAL_MS = 5_000;

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [eventsList, setEventsList] = useState<EventModel[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // The response plus the epoch of the lifecycle status inside it: a
  // lifecycle transition does not bump `event.version`, so the status needs
  // an ordering signal of its own. See `supervision.ts`.
  const [dashboardView, setDashboardView] = useState<DashboardView | null>(null);
  const eventDetail = dashboardView?.detail ?? null;

  // The lifecycle fence. Both counters live in refs because a refresh has to
  // read them at the moment it *starts*, which is outside any render.
  //
  // `lifecycleGenerationRef` counts lifecycle pushes for the event on
  // screen. A refresh reads it twice — as it is issued and as its response
  // arrives — and a difference means a push crossed it in flight. Reading
  // both ends from this one counter is what keeps the fence correct even
  // when a push lands before there is any view to apply it to.
  //
  // `requestSeqRef` numbers the refreshes themselves, so two concurrent ones
  // — the poll, and the one `LifecycleControls` fires through `onChanged` —
  // cannot land out of order and regress the status.
  const lifecycleGenerationRef = useRef(0);
  const requestSeqRef = useRef(0);
  const [loading, setLoading] = useState(true);

  // Load events list
  useEffect(() => {
    async function fetchEvents() {
      try {
        const list = await apiFetch<EventModel[]>('/api/v1/events');
        setEventsList(list);
        if (list.length > 0 && !selectedEventId) {
          // An explicit ?event= (e.g. the wizard just created a draft)
          // always wins — otherwise a live event elsewhere would hide it.
          const requestedId = searchParams.get('event');
          const requested = requestedId ? list.find((e) => e.id === requestedId) : undefined;
          const live = requested || list.find((e) => e.status === 'live' || e.status === 'closing') || list[0];
          setSelectedEventId(live.id);
        }
      } catch {
        navigate('/login');
      } finally {
        setLoading(false);
      }
    }
    fetchEvents();
  }, [navigate, selectedEventId, searchParams]);

  // The event the screen is currently about, readable from inside an
  // in-flight request without making the request's identity a dependency.
  const selectedEventIdRef = useRef<string | null>(selectedEventId);
  useEffect(() => {
    selectedEventIdRef.current = selectedEventId;
  }, [selectedEventId]);

  /**
   * Re-reads the supervision state for the selected event.
   *
   * Memoised, so the polling effect below depends on a stable reference
   * instead of being re-armed by every render — which is what previously
   * forced a lint suppression here.
   *
   * A failure is deliberately not surfaced as an error state: this runs on a
   * timer behind a screen the operator is reading, and blanking the gauge
   * because one request timed out would be worse than briefly showing state
   * a few seconds old. The last good snapshot stays, and the next tick
   * retries. A 401 is not swallowed by this: `apiFetch` routes it to the
   * auth guard, which is the only thing that may end the session.
   */
  const refreshDetails = useCallback(async () => {
    const requestedEventId = selectedEventIdRef.current;
    if (!requestedEventId) return;
    const generationAtStart = lifecycleGenerationRef.current;
    const requestSeq = ++requestSeqRef.current;
    try {
      const details = await apiFetch<EventDetailResponse>(`/api/v1/events/${requestedEventId}/state`);
      // Read again now the response is here: if the counter moved, a
      // transition was pushed while this request was in flight and the
      // lifecycle it carries is stale, whatever it says.
      const fence = {
        generationAtStart,
        generationAtEnd: lifecycleGenerationRef.current,
        requestSeq,
      };
      setDashboardView((prev) =>
        // Merged rather than assigned: the response also carries counting
        // state and a lifecycle status, either of which SSE may already have
        // moved past while it was in flight. It is dropped entirely if the
        // operator has since switched events.
        acceptSupervisionResponse(prev, details, selectedEventIdRef.current, fence) ?? prev
      );
    } catch (err) {
      console.debug('Supervision refresh failed; keeping the last known state:', err);
    }
  }, []);

  // Supervision is polled, counting is pushed.
  //
  // Each tick waits for the previous request to resolve before scheduling
  // the next, so a slow response can never produce overlapping requests, and
  // the timer is cleared when the event changes or the dashboard unmounts.
  useEffect(() => {
    if (!selectedEventId) return;
    // A new event starts its own fence: the counters describe the lifecycle
    // of the event on screen, not of the one just left.
    lifecycleGenerationRef.current = 0;
    requestSeqRef.current = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      await refreshDetails();
      if (!cancelled) {
        timer = setTimeout(tick, SUPERVISION_POLL_INTERVAL_MS);
      }
    };

    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [selectedEventId, refreshDetails]);

  // SSE Stream for Realtime Live Updates
  useSSE({
    url: selectedEventId ? `/api/v1/events/${selectedEventId}/stream` : '',
    enabled: !!selectedEventId,
    // Counting only. A state frame's `eventStatus` is not read: its
    // `serverTimeMs` is stamped after the event row was fetched, so a frame
    // can carry a status the server has already superseded under a
    // timestamp that looks newer than the transition. See `supervision.ts`.
    onState: (state: CompactEventState) => {
      setDashboardView((prev) => applyLiveState(prev, state));
    },
    // The lifecycle channel: every transition broadcasts this message with
    // the same `now` it writes to the event row, so it is ordered against
    // the `/state` refresh by the same quantity.
    onMessage: (message) => {
      if (message.type !== 'event-status') return;
      // Identity first, then the counter: a message about another event must
      // not move this event's fence.
      if (!isLifecyclePushForEvent(message.data, selectedEventIdRef.current)) return;
      // Bumped before any React state is touched, so a refresh already in
      // flight sees the change when it reads the counter again — even if
      // there is no view here yet for the transition to be applied to.
      lifecycleGenerationRef.current += 1;
      setDashboardView((prev) =>
        applyLifecycleMessage(prev, {
          eventId: message.data.eventId,
          status: message.data.status,
          timestampMs: message.data.timestampMs,
        })
      );
    },
  });

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <RefreshCw className="size-8 animate-spin text-primary-accent" />
      </div>
    );
  }

  if (eventsList.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6">
        <Card className="w-full max-w-md">
          <EmptyState
            icon={Users}
            title="Aucun événement configuré"
            description="Créez votre premier événement pour commencer le comptage de jauge en direct."
            action={
              <Button asChild className="mt-2">
                <Link to="/admin/events/new">
                  <Plus />
                  Créer un événement
                </Link>
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const currentEvent = eventDetail?.event || eventsList.find((e) => e.id === selectedEventId);
  const globalOccupancy = eventDetail?.occupancy.global || 0;
  const capacity = currentEvent?.capacity || 0;
  const capacityPercentage = capacity > 0 ? (globalOccupancy / capacity) * 100 : 0;
  const remaining = capacity - globalOccupancy;

  // Derived from the server's verdict *and* the devices it was computed
  // from, so the card can be specific ("1 appareil en ligne sur 2") without
  // ever re-deriving the verdict itself.
  const sync = summariseSyncQuality(eventDetail?.syncQuality ?? 'reliable', eventDetail?.devices ?? []);

  // The bar's colour is information, so it is derived from the gauge — and
  // always shown next to the written percentage, never instead of it.
  const gaugeIndicator =
    globalOccupancy > capacity && capacity > 0
      ? 'bg-over-capacity'
      : capacityPercentage >= 90
        ? 'bg-danger'
        : capacityPercentage >= 80
          ? 'bg-warning'
          : 'bg-success';

  return (
    <div className="flex-1 flex flex-col">
      {/* Top bar. `sticky-safe-top` rather than `top-0`: a sticky element
          offsets from the scrollport, not from #root, so at `top: 0` this
          bar would sit under the status bar in a standalone PWA. */}
      <header className="sticky sticky-safe-top z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-lg font-black tracking-tight text-foreground sm:text-xl">PaxFlux</span>
          <Badge tone="primary">Supervision</Badge>
        </div>

        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link to="/admin/system">Système</Link>
        </Button>

        {/* At 320px a selector sharing a row with "Nouvel événement" is
            about 110px wide — too narrow to tell two events apart. Each
            gets its own full-width row on a phone, and they return to one
            row from `sm` up. */}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          {/* `min-w-0` is what lets this selector be narrow: a form
              control's default minimum width is its content, so an event
              named at full length would otherwise stretch the header past
              the viewport rather than shrink. */}
          <NativeSelect
            aria-label="Événement supervisé"
            value={selectedEventId || ''}
            onChange={(e) => setSelectedEventId(e.target.value)}
            className="w-full sm:w-64"
          >
            {eventsList.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name} ({STATUS[eventStatusKey(ev.status)].label})
              </option>
            ))}
          </NativeSelect>

          <Button asChild size="sm" className="w-full sm:w-auto sm:shrink-0">
            <Link to="/admin/events/new">
              <Plus className="size-3.5" />
              Nouvel événement
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 space-y-4 p-4 sm:space-y-6 sm:p-6">
        <div className="grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-3">
          {/* Live gauge */}
          <Card className="flex flex-col justify-between p-4 sm:p-5 md:col-span-2">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                  Jauge en direct
                </h2>
                <p
                  data-testid="dashboard-event-name"
                  className="mt-1 break-words text-xl font-black text-foreground sm:text-2xl"
                >
                  {currentEvent?.name}
                </p>
              </div>
              <StatusBadge
                data-testid="event-status"
                status={eventStatusKey(currentEvent?.status)}
                className="shrink-0"
              />
            </div>

            {/* Occupancy, capacity and percentage wrap instead of forcing
                the card wider: a six-figure gauge next to a six-figure
                capacity does not fit on one line at 320px. */}
            <div className="my-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono">
              <span className="text-4xl font-black tracking-tight text-foreground sm:text-6xl">
                {globalOccupancy.toLocaleString('fr-FR')}
              </span>
              <span className="text-xl font-bold text-muted-foreground sm:text-2xl">
                / {capacity.toLocaleString('fr-FR')}
              </span>
              <span className="ml-auto font-sans text-sm font-semibold text-muted-foreground">
                {capacityPercentage.toFixed(1)} %
              </span>
            </div>

            <Progress
              className="mb-3"
              value={Math.min(capacityPercentage, 100)}
              indicatorClassName={gaugeIndicator}
              aria-label="Taux de remplissage"
            />

            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs font-semibold">
              <span className="text-muted-foreground">
                {remaining >= 0
                  ? `${remaining.toLocaleString('fr-FR')} places disponibles`
                  : `Dépassement de ${Math.abs(remaining).toLocaleString('fr-FR')}`}
              </span>
              <span className="text-muted-foreground">
                Version du journal : #{currentEvent?.version}
              </span>
            </div>
          </Card>

          {/* Sync health */}
          <Card className="flex flex-col justify-between p-4 sm:p-5">
            <div>
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">
                Qualité de synchronisation
              </h2>
              {/* Every critical fact is written, not signalled by the badge's
                  colour alone: how many devices answer, how many counts are
                  still in flight, and what the server's verdict means. */}
              <CardPanel className="mt-4 space-y-2">
                <StatusBadge status={sync.status} />
                <p data-testid="sync-presence" className="text-sm font-semibold text-foreground">
                  {sync.presence}
                </p>
                {sync.pending ? (
                  <p data-testid="sync-pending" className="text-xs font-semibold text-muted-foreground">
                    {sync.pending}
                  </p>
                ) : null}
                <p data-testid="sync-detail" className="text-xs text-muted-foreground">
                  {sync.detail}
                </p>
              </CardPanel>
            </div>

            {/* These two read as navigation rows rather than compact
                buttons, so they opt out of the Button's `whitespace-nowrap`:
                at exactly `md` the sync card is a third of the grid and
                "Gérer les appareils & QR codes" needs 249px in a 182px
                column. A button that keeps its label on one line is the
                right default; a full-width row of text is the exception. */}
            <div className="mt-6 flex flex-col gap-2">
              <Button
                asChild
                variant="secondary"
                block
                className="justify-between whitespace-normal py-2.5 text-left"
              >
                <Link to={`/admin/events/${selectedEventId}/devices`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <QrCode className="shrink-0 text-primary-accent" />
                    Gérer les appareils &amp; QR codes
                  </span>
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                </Link>
              </Button>

              <Button
                asChild
                variant="secondary"
                block
                className="justify-between whitespace-normal py-2.5 text-left"
              >
                <Link to={`/admin/events/${selectedEventId}/analytics`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Activity className="shrink-0 text-success" />
                    Statistiques détaillées
                  </span>
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                </Link>
              </Button>
            </div>
          </Card>
        </div>

        {currentEvent ? (
          <Section title="Cycle de vie de l'événement">
            <LifecycleControls event={currentEvent} onChanged={refreshDetails} />
          </Section>
        ) : null}

        <Section
          title="Répartition par zone"
          actions={
            <span className="text-xs text-muted-foreground">
              Total zones : {eventDetail?.spaces.length || 0}
            </span>
          }
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {eventDetail?.spaces
              .filter((sp: SpaceModel) => sp.kind !== 'external')
              .map((sp: SpaceModel) => {
                const occ = eventDetail.occupancy.spaces[sp.id] || 0;
                const spCap = sp.capacity || 0;
                const pct = spCap > 0 ? (occ / spCap) * 100 : 0;

                return (
                  <CardPanel key={sp.id} className="flex flex-col justify-between">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="break-words text-sm font-bold text-foreground">{sp.name}</h4>
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {sp.kind === 'leaf' ? 'Zone simple' : 'Agrégat'}
                        </span>
                      </div>
                      <span className="shrink-0 font-mono text-lg font-bold text-foreground">
                        {occ} {spCap > 0 ? `/ ${spCap}` : ''}
                      </span>
                    </div>

                    {spCap > 0 ? (
                      <div className="mt-3">
                        <Progress
                          className="h-2"
                          value={Math.min(pct, 100)}
                          indicatorClassName={pct >= 90 ? 'bg-danger' : 'bg-success'}
                          aria-label={`Remplissage ${sp.name}`}
                        />
                        <span className="mt-1 block text-right text-[10px] font-semibold text-muted-foreground">
                          {pct.toFixed(0)} %
                        </span>
                      </div>
                    ) : null}
                  </CardPanel>
                );
              })}
          </div>
        </Section>

        <Section
          title="Appareils et portes actives"
          contentClassName="p-0 sm:p-0"
          actions={
            <Button asChild variant="secondary" size="sm">
              <a href={`/api/v1/events/${selectedEventId}/export/movements.csv`} download>
                <Download className="size-3.5" />
                Exporter CSV
              </a>
            </Button>
          }
        >
          {/* The table keeps its own horizontal scroll area rather than
              widening the page: five columns of device state do not fit a
              phone, and folding them into cards is a redesign. */}
          <TableScroller className="px-1 pb-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Porte / checkpoint</TableHead>
                  <TableHead>Appareil</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead>Dernier contact</TableHead>
                  <TableHead>En attente</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eventDetail?.devices.map((dev) => (
                  <TableRow key={dev.id}>
                    <TableCell className="font-medium text-foreground">{dev.checkpointName}</TableCell>
                    <TableCell>{dev.label}</TableCell>
                    <TableCell>
                      <StatusText status={dev.isOnline ? 'online' : 'offline'} />
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">
                      {dev.lastSeenAtMs ? new Date(dev.lastSeenAtMs).toLocaleTimeString('fr-FR') : '—'}
                    </TableCell>
                    <TableCell className="font-mono">
                      {dev.lastPendingCount > 0 ? (
                        <span className="font-bold text-warning">{dev.lastPendingCount} actions</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {eventDetail?.devices.length === 0 ? (
                  <TableEmpty colSpan={5}>Aucun appareil appairé pour le moment.</TableEmpty>
                ) : null}
              </TableBody>
            </Table>
          </TableScroller>
        </Section>
      </main>
    </div>
  );
};
