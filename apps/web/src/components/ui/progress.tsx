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
    value={value}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn('h-full rounded-full transition-[width] duration-500', indicatorClassName)}
      style={{ width: `${Math.min(Math.max(value ?? 0, 0), 100)}%` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;
