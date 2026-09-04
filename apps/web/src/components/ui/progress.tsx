import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cn } from '@/lib/utils';

/**
 * The occupancy meter. `indicatorClassName` exists because the bar's colour
 * *is* information here — it crosses from success through warning to danger
 * and then to over-capacity — so the caller decides it from the gauge, and
 * always alongside the written percentage.
 */
export const Progress = React.forwardRef<
  React.ComponentRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }
>(({ className, value, indicatorClassName, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn('relative h-3 w-full overflow-hidden rounded-full border border-border bg-background', className)}
    // Clamped to the bar's own 0–100 scale, which is not the same thing as
    // clamping the count: the occupancy beside it is written out in full and
    // an incoherent one is reported, never corrected (ADR-004). Radix
    // `console.error`s a value outside the range and then renders nothing,
    // so an over-capacity or negative gauge — the two states this bar most
    // needs to be legible in — is where it would give up. `null` still means
    // indeterminate and is passed through.
    value={value === null || value === undefined ? value : Math.min(Math.max(value, 0), 100)}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn('h-full rounded-full transition-[width] duration-500', indicatorClassName)}
      style={{ width: `${Math.min(Math.max(value ?? 0, 0), 100)}%` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;
