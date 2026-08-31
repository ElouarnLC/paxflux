import * as React from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * One figure with its name and, optionally, a line of context under it.
 *
 * The value is the point, so it is the only thing allowed to be large — and
 * it wraps rather than widening the card, because Phase 7 established that a
 * five-figure count at 320px is a real case, not a hypothetical one.
 */
export function MetricCard({
  label,
  value,
  hint,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'neutral' | 'primary' | 'success' | 'danger';
  className?: string;
}) {
  const toneClass = {
    neutral: 'text-foreground',
    primary: 'text-primary-accent',
    success: 'text-success',
    danger: 'text-danger',
  }[tone];

  return (
    <Card className={cn('p-4 sm:p-5', className)}>
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={cn('block font-mono text-2xl font-black break-words sm:text-3xl', toneClass)}>
        {value}
      </span>
      {hint ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{hint}</span> : null}
    </Card>
  );
}
