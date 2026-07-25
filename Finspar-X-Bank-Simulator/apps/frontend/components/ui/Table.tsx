import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Table — zebra-free, hairline row separators, sticky header, right-aligned
 * numerics. Wrap in an overflow-x container so wide tables scroll. (§11)
 */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="w-full overflow-x-auto rounded-[var(--radius-card)] border border-border">
      <table className={cn('w-full border-collapse text-sm', className)}>{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-surface-raised">
      <tr className="border-b border-border">{children}</tr>
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function TR({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tr className={cn('border-b border-border last:border-0 hover:bg-bg/60', className)}>
      {children}
    </tr>
  );
}

interface CellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
}

export function TH({ children, numeric, className, ...props }: CellProps) {
  return (
    <th
      className={cn(
        'px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted',
        numeric ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
}

export function TD({ children, numeric, className, ...props }: TdProps) {
  return (
    <td
      className={cn(
        'px-4 py-3 text-text',
        numeric ? 'text-right tabular' : 'text-left',
        className,
      )}
      {...props}
    >
      {children}
    </td>
  );
}

/** Empty state — icon + one line + optional action, never a bare empty table. (§11) */
export function EmptyState({
  icon,
  message,
  action,
}: {
  icon?: ReactNode;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="text-text-muted">{icon}</div>}
      <p className="text-sm text-text-muted">{message}</p>
      {action}
    </div>
  );
}
