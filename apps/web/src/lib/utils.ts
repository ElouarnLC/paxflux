import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, letting a caller's utility win over a component's
 * default for the same CSS property rather than depending on source order.
 *
 * This is what makes the primitives in `components/ui` adaptable: a call
 * site can pass `className="min-h-14"` and actually get 14, instead of two
 * conflicting `min-h-*` classes whose winner is decided by where Tailwind
 * happened to emit them.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
