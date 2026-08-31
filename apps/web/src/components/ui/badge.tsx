import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * A pill. Every variant is a tinted surface plus a coloured label plus a
 * border of the same hue — never a bare colour — so the badge still reads
 * as a badge when the hue is the only thing that changed.
 *
 * Badges never carry meaning by colour alone in PaxFlux; see
 * `components/paxflux/status.tsx`, which is what pages actually use.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        primary: 'border-primary-accent/40 bg-primary/15 text-primary-accent',
        success: 'border-success/40 bg-success/15 text-success',
        warning: 'border-warning/40 bg-warning/15 text-warning',
        closing: 'border-closing/40 bg-closing/15 text-closing',
        danger: 'border-danger/40 bg-danger/15 text-danger',
        overCapacity: 'border-over-capacity/40 bg-over-capacity/15 text-over-capacity',
      },
    },
    defaultVariants: { tone: 'neutral' },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
