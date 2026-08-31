/**
 * The one description of what a PaxFlux form control looks like.
 *
 * Kept in a plain module rather than duplicated across three components so
 * an input, a textarea and a native select cannot drift apart — the drift
 * is what produced 22 near-identical field class strings before Phase 8.
 *
 * Two invariants from Phase 7 are encoded here and measured by the E2E
 * matrix, so they must not be edited casually:
 *
 *  - `text-base` up to `lg`. Below 16px, iOS Safari zooms the page when a
 *    field takes focus and never zooms back. The step down to a desktop
 *    density happens at `lg` (1024px), not `md`, because a 768px tablet is
 *    a touch device.
 *  - `min-h-11`. 44px is the floor for anything a thumb has to hit.
 */
export const fieldClassName = [
  'flex w-full min-w-0 min-h-11 rounded-lg border border-input bg-background px-3 py-2',
  'text-base lg:text-sm text-foreground',
  'placeholder:text-muted-foreground',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  'aria-invalid:border-danger aria-invalid:ring-danger/40',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'transition-colors',
].join(' ');
