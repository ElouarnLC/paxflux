import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A real table, in its own horizontal scroll area.
 *
 * Phase 7 settled this: six columns of device state do not fit a phone, and
 * folding them into cards is a redesign. `TableScroller` is the container
 * that scrolls; the document never does. `minWidth` is what forces the
 * scroll to happen inside it rather than widening the page.
 */
export function TableScroller({
  className,
  minWidth = '36rem',
  children,
}: {
  className?: string;
  minWidth?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <div style={{ minWidth }}>{children}</div>
    </div>
  );
}

export const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <table ref={ref} className={cn('w-full text-left text-xs text-foreground/80', className)} {...props} />
  )
);
Table.displayName = 'Table';

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      'border-b border-border text-[11px] font-semibold uppercase tracking-wider text-muted-foreground',
      className
    )}
    {...props}
  />
));
TableHeader.displayName = 'TableHeader';

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('divide-y divide-border', className)} {...props} />
));
TableBody.displayName = 'TableBody';

export const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr ref={ref} className={cn('hover:bg-accent/40', className)} {...props} />
  )
);
TableRow.displayName = 'TableRow';

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th ref={ref} className={cn('px-4 py-3 font-semibold', className)} {...props} />
));
TableHead.displayName = 'TableHead';

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-4 py-3 align-middle', className)} {...props} />
));
TableCell.displayName = 'TableCell';

export function TableEmpty({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-6 text-center text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}
