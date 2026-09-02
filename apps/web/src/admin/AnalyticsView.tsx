import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { AnalyticsResponse } from '@paxflux/shared';
import { RefreshCw } from 'lucide-react';
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
import { Progress } from '@/components/ui/progress';
import { CardPanel } from '@/components/ui/card';
import { MetricCard } from '@/components/paxflux/metric-card';
import { PageHeader, Section } from '@/components/paxflux/layout';
import { formatNetDelta, operationalSpaces } from './analytics-presentation.js';

/**
 * How often the analytics screen re-reads the endpoint.
 *
 * Chosen from the endpoint's measured cost rather than from taste.
 * `computeEventAnalytics` reads every movement of the event and folds them
 * in JS on each request, so it is linear in the ledger: measured on this
 * machine at roughly 31ms for 5 000 movements, 134ms for 20 000, 354ms for
 * 50 000 and 682ms for 100 000 — about 6.8µs per movement.
 *
 * At twelve seconds, a supervisor watching a 100 000-movement event costs
 * the server around 6% of one core; at one second the same event would cost
 * more than half a core per supervisor, which is why this is deliberately
 * not a fast poll and why nothing here reacts per movement. Twelve seconds
 * is well inside the useful range for cumulative statistics, whose slowest
 * component — the five-minute flow window — moves on a scale of minutes.
 */
const ANALYTICS_REFRESH_INTERVAL_MS = 12_000;

export const AnalyticsView: React.FC = () => {
  const { id: eventId } = useParams<{ id: string }>();
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAtMs, setUpdatedAtMs] = useState<number | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);

  // The event this screen is about, readable from inside an in-flight
  // request so a response for a previous event can be discarded rather than
  // rendered under the new one.
  const eventIdRef = useRef<string | undefined>(eventId);
  useEffect(() => {
    eventIdRef.current = eventId;
  }, [eventId]);

  /**
   * Re-reads the analytics for the current event.
   *
   * A failure keeps the last good figures on screen and is recorded so the
   * header can say the numbers have stopped advancing; the next tick
   * retries. It deliberately does not clear `data` — a transient 500 during
   * a busy event should not blank the supervisor's statistics — and it
   * deliberately does not end the session: `apiFetch` already routes a 401
   * to the auth guard, which is the only thing entitled to decide the
   * session is over.
   */
  const loadAnalytics = useCallback(async () => {
    const requestedEventId = eventIdRef.current;
    if (!requestedEventId) return;
    try {
      const res = await apiFetch<AnalyticsResponse>(`/api/v1/events/${requestedEventId}/analytics`);
      // Discarded if the operator has moved to another event while this was
      // in flight: the response describes an event no longer on screen.
      if (eventIdRef.current !== requestedEventId) return;
      setData(res);
      setUpdatedAtMs(Date.now());
      setRefreshFailed(false);
    } catch (err) {
      if (eventIdRef.current !== requestedEventId) return;
      console.debug('Analytics refresh failed; keeping the last known figures:', err);
      setRefreshFailed(true);
    } finally {
      if (eventIdRef.current === requestedEventId) setLoading(false);
    }
  }, []);

  // Each tick waits for the previous request to resolve before scheduling
  // the next, so a slow response cannot produce overlapping requests, and
  // the timer is cleared when the event changes or the screen unmounts. No
  // event id means no requests at all.
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      await loadAnalytics();
      if (!cancelled) {
        timer = setTimeout(tick, ANALYTICS_REFRESH_INTERVAL_MS);
      }
    };

    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [eventId, loadAnalytics]);

  if (loading || !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <RefreshCw className="size-8 animate-spin text-primary-accent" />
      </div>
    );
  }

  const zones = operationalSpaces(data.spaceStats);

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 space-y-4 p-4 sm:space-y-6 sm:p-6">
      <PageHeader title="Statistiques et analyse de flux" />

      {/* Freshness is written, because every figure below is a snapshot and
          an operator needs to know when it stopped advancing. */}
      <p data-testid="analytics-freshness" className="-mt-2 text-xs text-muted-foreground">
        {refreshFailed
          ? 'Actualisation indisponible : chiffres figés à ' +
            (updatedAtMs ? new Date(updatedAtMs).toLocaleTimeString('fr-FR') : '—') +
            '. Nouvelle tentative en cours.'
          : `Dernière mise à jour : ${updatedAtMs ? new Date(updatedAtMs).toLocaleTimeString('fr-FR') : '—'}`}
      </p>

      {/* Two columns at 320px gives each card about 130px, which is not
          enough for "Pic de fréquentation" above a five-figure number — so
          the pair only forms once there is room for it. */}
      <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 sm:gap-4 md:grid-cols-4">
        <MetricCard
          label="Jauge actuelle"
          value={
            <>
              <span data-testid="analytics-current-occupancy">{data.currentOccupancy}</span>{' '}
              <span className="text-sm font-normal text-muted-foreground">/ {data.capacity}</span>
            </>
          }
        />
        <MetricCard
          label="Pic de fréquentation"
          tone="primary"
          value={data.peakOccupancy}
          hint={
            data.peakOccupancyTimeMs
              ? new Date(data.peakOccupancyTimeMs).toLocaleTimeString('fr-FR')
              : '—'
          }
        />
        <MetricCard
          label="Entrées cumulées"
          tone="success"
          value={<span data-testid="analytics-total-entries">+{data.totalEntries}</span>}
          hint="depuis l’extérieur"
        />
        <MetricCard
          label="Sorties cumulées"
          tone="danger"
          value={<span data-testid="analytics-total-exits">−{data.totalExits}</span>}
          hint="vers l’extérieur"
        />
      </div>

      {/* Recent flow: the one figure on this page that says what is
          happening *now* rather than since the start. */}
      <Section title="Flux des 5 dernières minutes">
        <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-3 sm:gap-4">
          <MetricCard
            label="Entrées récentes"
            tone="success"
            value={<span data-testid="analytics-recent-entries">+{data.flowRecent5Min.entries}</span>}
          />
          <MetricCard
            label="Sorties récentes"
            tone="danger"
            value={<span data-testid="analytics-recent-exits">−{data.flowRecent5Min.exits}</span>}
          />
          <MetricCard
            label="Solde net récent"
            value={
              <span data-testid="analytics-recent-net">{formatNetDelta(data.flowRecent5Min.netDelta)}</span>
            }
            hint={
              data.flowRecent5Min.netDelta > 0
                ? 'la jauge monte'
                : data.flowRecent5Min.netDelta < 0
                  ? 'la jauge descend'
                  : 'jauge stable'
            }
          />
        </div>
      </Section>

      <Section
        title="Répartition par zone"
        actions={
          <span className="text-xs text-muted-foreground">
            Solde net cumulé : <span data-testid="analytics-net-delta">{formatNetDelta(data.netDelta)}</span>
          </span>
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {zones.map((zone) => {
            const capacity = zone.capacity ?? 0;
            const percentage = capacity > 0 ? (zone.occupancy / capacity) * 100 : 0;

            return (
              <CardPanel key={zone.spaceId} className="flex flex-col justify-between">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="break-words text-sm font-bold text-foreground">{zone.spaceName}</h4>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {zone.kind === 'leaf' ? 'Zone simple' : 'Agrégat'}
                    </span>
                  </div>
                  <span className="shrink-0 font-mono text-lg font-bold text-foreground">
                    {zone.occupancy}
                    {capacity > 0 ? ` / ${capacity}` : ''}
                  </span>
                </div>

                {capacity > 0 ? (
                  <div className="mt-3">
                    <Progress
                      className="h-2"
                      value={Math.min(percentage, 100)}
                      indicatorClassName={percentage >= 90 ? 'bg-danger' : 'bg-success'}
                      aria-label={`Remplissage ${zone.spaceName}`}
                    />
                    <span className="mt-1 block text-right text-[10px] font-semibold text-muted-foreground">
                      {percentage.toFixed(0)} %
                    </span>
                  </div>
                ) : (
                  <span className="mt-3 block text-[11px] text-muted-foreground">Aucune capacité définie</span>
                )}
              </CardPanel>
            );
          })}
        </div>
      </Section>

      <Section title="Flux cumulés par porte" contentClassName="p-0 sm:p-0">
        <TableScroller className="px-1 pb-4" minWidth="30rem">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Porte</TableHead>
                <TableHead>Entrées</TableHead>
                <TableHead>Sorties</TableHead>
                <TableHead>Solde net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.checkpointStats.map((checkpoint) => (
                <TableRow key={checkpoint.checkpointId}>
                  <TableCell className="font-medium text-foreground">{checkpoint.checkpointName}</TableCell>
                  <TableCell className="font-mono text-success">+{checkpoint.entries}</TableCell>
                  <TableCell className="font-mono text-danger">−{checkpoint.exits}</TableCell>
                  <TableCell className="font-mono font-bold text-foreground">
                    {formatNetDelta(checkpoint.entries - checkpoint.exits)}
                  </TableCell>
                </TableRow>
              ))}
              {data.checkpointStats.length === 0 ? (
                <TableEmpty colSpan={4}>Aucune porte configurée sur cet événement.</TableEmpty>
              ) : null}
            </TableBody>
          </Table>
        </TableScroller>
      </Section>
    </div>
  );
};
