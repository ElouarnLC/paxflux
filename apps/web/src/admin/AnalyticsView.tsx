import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { AnalyticsResponse } from '@paxflux/shared';
import { RefreshCw } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroller,
} from '@/components/ui/table';
import { MetricCard } from '@/components/paxflux/metric-card';
import { PageHeader, Section } from '@/components/paxflux/layout';

export const AnalyticsView: React.FC = () => {
  const { id: eventId } = useParams<{ id: string }>();
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAnalytics() {
      if (!eventId) return;
      try {
        const res = await apiFetch<AnalyticsResponse>(`/api/v1/events/${eventId}/analytics`);
        setData(res);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    loadAnalytics();
  }, [eventId]);

  if (loading || !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <RefreshCw className="size-8 animate-spin text-primary-accent" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 space-y-4 p-4 sm:space-y-6 sm:p-6">
      <PageHeader title="Statistiques & Analyse de Flux" />

      {/* Two columns at 320px gives each card about 130px, which is not
          enough for "Pic de Fréquentation" above a five-figure number — so
          the pair only forms once there is room for it. */}
      <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 sm:gap-4 md:grid-cols-4">
        <MetricCard
          label="Jauge Actuelle"
          value={
            <>
              {data.currentOccupancy}{' '}
              <span className="text-sm font-normal text-muted-foreground">/ {data.capacity}</span>
            </>
          }
        />
        <MetricCard
          label="Pic de Fréquentation"
          tone="primary"
          value={data.peakOccupancy}
          hint={
            data.peakOccupancyTimeMs
              ? new Date(data.peakOccupancyTimeMs).toLocaleTimeString('fr-FR')
              : '—'
          }
        />
        <MetricCard
          label="Entrées Cumulées"
          tone="success"
          value={`+${data.totalEntries}`}
          hint="depuis l'extérieur"
        />
        <MetricCard
          label="Sorties Cumulées"
          tone="danger"
          value={`−${data.totalExits}`}
          hint="vers l'extérieur"
        />
      </div>

      <Section title="Flux Cumulés par Porte" contentClassName="p-0 sm:p-0">
        <TableScroller className="px-1 pb-4" minWidth="30rem">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Porte</TableHead>
                <TableHead>Entrées</TableHead>
                <TableHead>Sorties</TableHead>
                <TableHead>Solde Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.checkpointStats.map((cp: any) => (
                <TableRow key={cp.checkpointId}>
                  <TableCell className="font-medium text-foreground">{cp.checkpointName}</TableCell>
                  <TableCell className="font-mono text-success">+{cp.entries}</TableCell>
                  <TableCell className="font-mono text-danger">−{cp.exits}</TableCell>
                  <TableCell className="font-mono font-bold text-foreground">
                    {cp.entries - cp.exits > 0 ? `+${cp.entries - cp.exits}` : cp.entries - cp.exits}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroller>
      </Section>
    </div>
  );
};
