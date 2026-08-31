import { cn } from '@/lib/utils';

/**
 * A loading placeholder. The pulse is an expression of state — "this is
 * still arriving" — not decoration, which is the only kind of animation
 * PaxFlux keeps.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}
