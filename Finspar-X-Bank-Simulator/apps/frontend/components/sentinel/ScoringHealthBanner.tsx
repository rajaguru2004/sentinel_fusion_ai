'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';

interface ScoringHealth {
  sentinelEnabled: boolean;
  degraded: boolean;
  fallbackRate: number;
  windowSize: number;
  totals: { scored: number; fellBack: number; storeUnavailable: number };
  lastFallback: { at: string; reason: string; detail: string } | null;
  lastSuccess: string | null;
}

/**
 * Surfaces silent fail-open (ENHANCEMENTS.md §3).
 *
 * When Sentinel errors, the backend correctly falls back to the heuristic so the
 * money path keeps moving. The danger is that this is invisible: verdicts on
 * screen look identical whether a trained model or a rule table produced them.
 * This banner makes the difference legible to the person acting on those verdicts.
 *
 * Renders nothing while scoring is healthy — a banner that is always present is
 * a banner nobody reads.
 */
export function ScoringHealthBanner() {
  const { data } = useQuery<ScoringHealth>({
    queryKey: ['scoring-health'],
    queryFn: async () => (await api.get('/health/scoring')).data,
    refetchInterval: 10_000,
  });

  if (!data?.degraded) return null;

  const pct = Math.round(data.fallbackRate * 100);
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-[var(--radius-card)] border border-risk-high/40 bg-risk-high/10 p-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-risk-high" />
      <div className="min-w-0">
        <p className="font-medium text-risk-high">Fraud scoring is degraded</p>
        <p className="mt-0.5 text-xs leading-relaxed text-text-muted">
          {pct}% of the last {data.windowSize} events fell back to the rule-based heuristic
          because the Sentinel model was unreachable. Payments are still being scored and the
          money path is unaffected — but these verdicts are <strong>rules, not the model</strong>,
          so treat borderline decisions with more caution than usual.
          {data.lastFallback && (
            <>
              {' '}
              Last failure: <span className="font-mono">{data.lastFallback.detail}</span>.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
