import React, { useState, useEffect } from 'react';
import { apiFetch } from '../api/client.js';
import { SystemStatusResponse } from '@paxflux/shared';
import { RefreshCw, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { MetricCard } from '@/components/paxflux/metric-card';
import { PageHeader, Section } from '@/components/paxflux/layout';

export const SystemPanel: React.FC = () => {
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  const [backups, setBackups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);

  const fetchStatus = async () => {
    try {
      const [st, bkList] = await Promise.all([
        apiFetch<SystemStatusResponse>('/api/v1/system/status'),
        apiFetch<any[]>('/api/v1/system/backups'),
      ]);
      setStatus(st);
      setBackups(bkList);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleManualBackup = async () => {
    setBackingUp(true);
    try {
      await apiFetch('/api/v1/system/backups', {
        method: 'POST',
        body: JSON.stringify({ reason: 'admin_manual' }),
      });
      fetchStatus();
    } catch {
      // ignore
    } finally {
      setBackingUp(false);
    }
  };

  if (loading || !status) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <RefreshCw className="size-8 animate-spin text-primary-accent" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 space-y-4 p-4 sm:space-y-6 sm:p-6">
      <PageHeader title="État Système & Sauvegardes" />

      {/* Same breakpoint reasoning as the analytics stats: two columns only
          once they can be read. */}
      <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 sm:gap-4 md:grid-cols-4">
        <MetricCard label="Version" value={status.version} hint={status.nodeVersion} />
        <MetricCard
          label="Intégrité DB"
          tone={status.database.quickCheckOk ? 'success' : 'danger'}
          value={status.database.quickCheckOk ? 'OK' : 'ATTENTION'}
          hint="PRAGMA quick_check"
        />
        <MetricCard
          label="Taille Base"
          value={
            <>
              {(status.database.sizeBytes / 1024).toFixed(1)}{' '}
              <span className="text-sm font-normal text-muted-foreground">KB</span>
            </>
          }
          hint={`WAL: ${(status.database.walSizeBytes / 1024).toFixed(1)} KB`}
        />
        <MetricCard
          label="Uptime"
          tone="primary"
          value={
            <>
              {Math.floor(status.uptimeSeconds / 60)}{' '}
              <span className="text-sm font-normal text-muted-foreground">min</span>
            </>
          }
          hint={`${status.connectedSSECount} flux SSE actifs`}
        />
      </div>

      <Section
        title="Historique des Sauvegardes SQLite"
        contentClassName="p-0 sm:p-0"
        actions={
          <Button size="sm" disabled={backingUp} onClick={handleManualBackup}>
            {backingUp ? <RefreshCw className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            Créer une sauvegarde maintenant
          </Button>
        }
      >
        <TableScroller className="px-1 pb-4" minWidth="38rem">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fichier</TableHead>
                <TableHead>Motif</TableHead>
                <TableHead>Taille</TableHead>
                <TableHead>SHA-256</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium text-foreground">{b.filename}</TableCell>
                  <TableCell className="text-muted-foreground">{b.reason}</TableCell>
                  <TableCell className="font-mono">{(b.sizeBytes / 1024).toFixed(1)} KB</TableCell>
                  <TableCell className="max-w-xs truncate font-mono text-muted-foreground">
                    {b.sha256.substring(0, 16)}...
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {new Date(b.createdAtMs).toLocaleString('fr-FR')}
                  </TableCell>
                </TableRow>
              ))}
              {backups.length === 0 ? (
                <TableEmpty colSpan={5}>Aucune sauvegarde enregistrée.</TableEmpty>
              ) : null}
            </TableBody>
          </Table>
        </TableScroller>
      </Section>
    </div>
  );
};
