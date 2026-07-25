import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface CardProps {
  title?: ReactNode;
  /** Top-right actions — ghost or outline buttons (§11). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Card — white/surface, 1px border, soft shadow, NO coloured header bar.
 * The title sits inside the card; actions go top-right. (§11)
 */
export function Card({ title, actions, children, className }: CardProps) {
  return (
    <section
      className={cn(
        'rounded-[var(--radius-card)] border border-border bg-surface shadow-sm',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 px-6 pt-5 pb-3">
          {title && <h2 className="text-base font-semibold text-text">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-6 pb-6 pt-1">{children}</div>
    </section>
  );
}
