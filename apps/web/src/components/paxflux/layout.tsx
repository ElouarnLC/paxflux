import * as React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * The "back on the left, title on the right" pattern, which Phase 7 had to
 * fold on every admin page separately. Written once: the heading comes
 * first in the DOM (so a screen reader meets the page's name before its
 * escape hatch) and `sm:flex-row-reverse` puts the link back on the left at
 * desktop, where that layout came from.
 */
export function PageHeader({
  title,
  backTo = '/admin',
  backLabel = 'Retour au tableau de bord',
  actions,
}: {
  title: string;
  backTo?: string;
  backLabel?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row-reverse sm:items-center sm:justify-between sm:gap-3">
      <h1 className="text-lg font-bold break-words text-foreground sm:text-xl">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={backTo}
          className="inline-flex min-h-11 items-center gap-2 self-start rounded-lg text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4 shrink-0" /> {backLabel}
        </Link>
        {actions}
      </div>
    </div>
  );
}

/**
 * A titled section of a page. Renders a real `<section>` with a real
 * heading, which is what makes "the lifecycle controls" addressable both to
 * a screen reader and to a test.
 */
export function Section({
  title,
  actions,
  className,
  contentClassName,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  // A real <section>, not a Card wrapping one: the landmark and the surface
  // are the same box, so the heading a screen reader announces is the
  // heading of the thing it is looking at.
  return (
    <section
      className={cn('rounded-xl border border-border bg-card text-card-foreground', className)}
    >
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        {actions}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </section>
  );
}

/** The nothing-here state: an icon, a sentence, and the way out. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <Icon className="size-10 text-muted-foreground" />
      <p className="text-base font-bold text-foreground">{title}</p>
      {description ? <p className="max-w-sm text-xs text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

/**
 * A centred card, used by every screen that is a single panel on an
 * otherwise empty page: login, setup, pairing, the auth error state.
 */
export function CenteredPanel({
  icon: Icon,
  tone = 'primary',
  title,
  description,
  children,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'primary' | 'danger';
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('w-full max-w-md p-6 sm:p-8', className)}>
      {Icon ? (
        <div
          className={cn(
            'mx-auto mb-6 flex size-14 items-center justify-center rounded-xl border',
            tone === 'danger'
              ? 'border-danger/40 bg-danger/10 text-danger'
              : 'border-primary-accent/40 bg-primary/10 text-primary-accent'
          )}
        >
          <Icon className="size-7" />
        </div>
      ) : null}
      <h1 className="text-center text-2xl font-bold text-foreground">{title}</h1>
      {description ? (
        <div className="mt-2 text-center text-xs leading-relaxed text-muted-foreground">{description}</div>
      ) : null}
      {children}
    </Card>
  );
}
