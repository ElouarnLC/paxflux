import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fieldClassName } from './field';

/**
 * A real `<select>`, deliberately.
 *
 * PaxFlux's selects — the event picker, the checkpoint picker, the wizard's
 * endpoints — are used on a phone, where the platform's own picker is a
 * full-height wheel with momentum, type-ahead and no dependence on the page
 * scrolling correctly. A Radix popover reimplements all of that worse. So
 * this styles the native control instead of replacing it, which also keeps
 * the accessible role, the keyboard behaviour and `selectOption()` in the
 * existing E2E suite exactly as they were.
 *
 * The chevron is decorative and `aria-hidden`: the control announces itself.
 */
export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <div className="relative w-full min-w-0">
    <select
      ref={ref}
      className={cn(fieldClassName, 'appearance-none pr-9', className)}
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      aria-hidden="true"
      className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
    />
  </div>
));
NativeSelect.displayName = 'NativeSelect';
