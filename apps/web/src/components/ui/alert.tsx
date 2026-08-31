import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * A block-level notice. The icon slot is not decoration: an alert that
 * distinguishes "offline" from "revoked" by hue alone conveys nothing to an
 * operator who cannot separate the two, so a tone always arrives with an
 * icon and a written label.
 */
const alertVariants = cva('flex items-start gap-2.5 rounded-lg border p-3 text-xs [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:mt-0.5', {
  variants: {
    tone: {
      neutral: 'border-border bg-muted text-foreground/90 [&_svg]:text-muted-foreground',
      info: 'border-primary-accent/40 bg-primary/10 text-foreground/90 [&_svg]:text-primary-accent',
      success: 'border-success/40 bg-success/10 text-foreground/90 [&_svg]:text-success',
      warning: 'border-warning/40 bg-warning/10 text-foreground/90 [&_svg]:text-warning',
      closing: 'border-closing/40 bg-closing/10 text-foreground/90 [&_svg]:text-closing',
      danger: 'border-danger/40 bg-danger/10 text-foreground/90 [&_svg]:text-danger',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, tone, ...props }, ref) => (
    <div ref={ref} role="status" className={cn(alertVariants({ tone }), className)} {...props} />
  )
);
Alert.displayName = 'Alert';

export const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('font-bold text-foreground', className)} {...props} />
));
AlertTitle.displayName = 'AlertTitle';

export const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('mt-0.5 leading-snug text-muted-foreground', className)} {...props} />
));
AlertDescription.displayName = 'AlertDescription';
