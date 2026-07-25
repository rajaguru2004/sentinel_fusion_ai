import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const tones: Record<Tone, string> = {
  neutral: 'bg-bg text-text-muted border-border',
  success: 'bg-risk-low/10 text-risk-low border-risk-low/30',
  warning: 'bg-risk-medium/10 text-risk-medium border-risk-medium/30',
  danger: 'bg-risk-critical/10 text-risk-critical border-risk-critical/30',
  info: 'bg-accent/10 text-accent border-accent/30',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

const riskStyles: Record<RiskLevel, string> = {
  LOW: 'bg-risk-low/10 text-risk-low border-risk-low/30',
  MEDIUM: 'bg-risk-medium/10 text-risk-medium border-risk-medium/30',
  HIGH: 'bg-risk-high/10 text-risk-high border-risk-high/30',
  CRITICAL: 'bg-risk-critical/10 text-risk-critical border-risk-critical/30',
};

/** Risk badge — carries real meaning; used on statement rows and the analyst feed. */
export function RiskBadge({ level, className }: { level: RiskLevel; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        riskStyles[level],
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {level}
    </span>
  );
}
