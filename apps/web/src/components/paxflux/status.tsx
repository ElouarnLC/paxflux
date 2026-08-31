import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  FileText,
  Lock,
  Radio,
  RefreshCw,
  ShieldCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Every status PaxFlux can be in, described once.
 *
 * Before this, a page decided for itself that `closing` was orange and
 * spelled it `bg-orange-950/80 border-orange-500/40 text-orange-300` — nine
 * times, with three different opacities. Worse, some of those were the only
 * thing distinguishing two states: an operator who cannot separate the hues
 * read the same badge either way.
 *
 * So the rule here is structural, not stylistic: a status is a *word*, a
 * tone and an icon. The word is never optional. `StatusBadge` cannot be
 * rendered without one, because the label comes from this table rather than
 * from the call site.
 */
export type StatusKey =
  // Event lifecycle
  | 'draft'
  | 'live'
  | 'closing'
  | 'closed'
  | 'archived'
  // Aggregate sync quality, as the supervisor sees it
  | 'reliable'
  | 'degraded'
  | 'unreliable'
  // A single device, as the supervisor sees it
  | 'online'
  | 'offline'
  | 'pending'
  // A single device, as the device itself sees it
  | 'revoked'
  | 'reconciliation'
  | 'syncing'
  | 'synced';

interface StatusDescriptor {
  label: string;
  tone: NonNullable<BadgeProps['tone']>;
  Icon: React.ComponentType<{ className?: string }>;
  /** Set where the state is one an operator has to act on, not just read. */
  pulse?: boolean;
}

export const STATUS: Record<StatusKey, StatusDescriptor> = {
  draft: { label: 'Brouillon', tone: 'neutral', Icon: FileText },
  live: { label: 'En direct', tone: 'success', Icon: Radio, pulse: true },
  closing: { label: 'Fermeture', tone: 'closing', Icon: Lock },
  closed: { label: 'Clos', tone: 'neutral', Icon: Lock },
  archived: { label: 'Archivé', tone: 'neutral', Icon: Archive },

  reliable: { label: 'Fiable', tone: 'success', Icon: ShieldCheck },
  degraded: { label: 'Dégradée', tone: 'warning', Icon: AlertTriangle },
  unreliable: { label: 'Non garantie', tone: 'danger', Icon: AlertTriangle },

  online: { label: 'En ligne', tone: 'success', Icon: Wifi },
  offline: { label: 'Hors ligne', tone: 'danger', Icon: WifiOff },
  pending: { label: 'En attente', tone: 'warning', Icon: Activity },

  revoked: { label: 'Révoqué', tone: 'danger', Icon: Lock },
  reconciliation: { label: 'À régulariser', tone: 'closing', Icon: AlertTriangle },
  syncing: { label: 'Synchronisation', tone: 'warning', Icon: RefreshCw, pulse: true },
  synced: { label: 'Synchronisé', tone: 'success', Icon: CheckCircle2 },
};

export interface StatusBadgeProps extends Omit<BadgeProps, 'tone' | 'children'> {
  status: StatusKey;
  /** Appended to the label, e.g. a pending count: "Hors ligne (3)". */
  detail?: string | number;
  /** Uppercased, for the counter's header where it reads as a signal. */
  emphatic?: boolean;
}

export function StatusBadge({ status, detail, emphatic, className, ...props }: StatusBadgeProps) {
  const { label, tone, Icon, pulse } = STATUS[status];
  return (
    <Badge
      tone={tone}
      className={cn(emphatic && 'uppercase tracking-wide', className)}
      {...props}
    >
      <Icon className={cn(pulse && 'animate-pulse')} />
      {label}
      {detail !== undefined && detail !== '' ? ` (${detail})` : null}
    </Badge>
  );
}

/** The written status label on its own, for tables and dense rows. */
export function StatusText({
  status,
  className,
}: {
  status: StatusKey;
  className?: string;
}) {
  const { label, tone, Icon } = STATUS[status];
  const toneClass: Record<NonNullable<BadgeProps['tone']>, string> = {
    neutral: 'text-muted-foreground',
    primary: 'text-primary-accent',
    success: 'text-success',
    warning: 'text-warning',
    closing: 'text-closing',
    danger: 'text-danger',
    overCapacity: 'text-over-capacity',
  };
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-semibold', toneClass[tone], className)}>
      <Icon className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}

/** Maps a server event status onto the status vocabulary. */
export function eventStatusKey(status: string | undefined): StatusKey {
  switch (status) {
    case 'live':
      return 'live';
    case 'closing':
      return 'closing';
    case 'closed':
      return 'closed';
    case 'archived':
      return 'archived';
    default:
      return 'draft';
  }
}
