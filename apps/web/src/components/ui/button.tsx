import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * The sizes here are PaxFlux's, not the registry's.
 *
 * shadcn ships a 36px default button. PaxFlux is operated with a thumb, and
 * Phase 7 established 44×44 as the floor for anything tappable — a floor a
 * Playwright sweep measures on every touch viewport. So `default` is 44 tall,
 * `icon` is 44 square, and `sm` still clears 44 while looking smaller by
 * spending less horizontal padding rather than less height.
 *
 * `focus-visible:outline-none` is paired with a real ring on the very next
 * line. That pairing is the whole rule: the global `:focus-visible` outline
 * in styles/index.css is a floor for everything not yet migrated, and a
 * primitive may only step out from under it by drawing its own indicator —
 * never by removing one.
 */
const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg',
    'text-sm font-semibold transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ].join(' '),
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
        outline: 'border border-border bg-transparent text-foreground hover:bg-accent',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive',
        // Business variants exist only because a lifecycle transition is a
        // coloured decision the operator has to recognise before reading it:
        // starting an event is green, closing it is orange.
        success: 'bg-success text-success-foreground hover:bg-success/90',
        closing: 'bg-closing text-closing-foreground hover:bg-closing/90',
        // Force-close and reopen are not ordinary destructive actions: they
        // override a refusal the system made on purpose. They read as an
        // outlined warning, never as a filled default anyone taps by habit.
        danger: 'border border-danger/60 bg-transparent text-danger hover:bg-danger/10',
      },
      size: {
        default: 'min-h-11 px-4 py-2',
        sm: 'min-h-11 px-3 py-1.5 text-xs',
        lg: 'min-h-12 px-6 text-base',
        icon: 'min-h-11 min-w-11 px-0',
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'default', size: 'default', block: false },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, block, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        // A <button> inside a form defaults to `submit`. Most of these are
        // not submits, and the two that are say so explicitly.
        type={asChild ? undefined : (type ?? 'button')}
        className={cn(buttonVariants({ variant, size, block }), className)}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { buttonVariants };
