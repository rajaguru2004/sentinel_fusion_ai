'use client';

import { RiskBadge, type RiskLevel as BadgeLevel } from '@/components/ui/Badge';
import {
  BAND_EDGES,
  CONTRIBUTION_LABELS,
  type Contributions,
  type ScoreOut,
} from '@/lib/sentinel';

/** The model answers in lowercase; the bank's Prisma enum is uppercase. */
const toBadge = (level: string): BadgeLevel => level.toUpperCase() as BadgeLevel;

function BandScale({ model, score }: { model: string | null; score: number }) {
  const edges = model ? BAND_EDGES[model] : undefined;
  if (!edges) return null;
  return (
    <p className="text-xs text-text-muted">
      Band edges for <span className="font-medium text-text">{model}</span>: medium ≥{' '}
      {edges.medium}, high ≥ {edges.high}, critical ≥ {edges.critical} — this score is {score.toFixed(4)}.
      <span className="ml-1 opacity-80">
        Fitted per model at cost-optimal thresholds, so a small number can still be a high alert.
      </span>
    </p>
  );
}

function ContributionBars({ contributions }: { contributions: Contributions }) {
  const entries = (Object.keys(contributions) as (keyof Contributions)[])
    // p_fraud is a deprecated mirror of p_fraud_payment — showing both reads as
    // two watchers firing when only one did.
    .filter((k) => k !== 'p_fraud')
    .map((k) => [k, contributions[k]] as const);

  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => {
        const fired = typeof value === 'number';
        return (
          <div key={key} className="flex items-center gap-3">
            <span className="w-56 shrink-0 text-xs text-text-muted">{CONTRIBUTION_LABELS[key]}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg">
              {fired && (
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }}
                />
              )}
            </div>
            <span className="w-16 shrink-0 text-right text-xs font-medium text-text">
              {fired ? value.toFixed(4) : '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function VerdictCard({ result }: { result: ScoreOut }) {
  const d = result.degradation;
  return (
    <div className="space-y-5 rounded-[var(--radius-card)] border border-border bg-bg/40 p-5">
      {/* Headline */}
      <div className="flex flex-wrap items-center gap-3">
        <RiskBadge level={toBadge(result.risk_level)} />
        <span className="text-2xl font-semibold text-text">{result.risk_score.toFixed(4)}</span>
        <span className="text-sm text-text-muted">
          routed to <span className="font-medium text-text">{result.model ?? 'no model'}</span>
          {!result.scored && ' — not scored by any head'}
        </span>
        <span className="ml-auto text-xs text-text-muted">v{result.model_version}</span>
      </div>

      <BandScale model={result.model} score={result.risk_score} />

      {/* Why */}
      {result.explanation?.reasons?.length ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-text">Why the model said this</p>
          <div className="flex flex-wrap gap-2">
            {result.explanation.reasons.map((r) => (
              <span
                key={r}
                className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-text"
              >
                {r}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-text-muted">
          No plain-language reasons returned. The model only emits these when a feature deviates
          enough to name; an established entity with unremarkable features often returns none.
        </p>
      )}

      {/* Fusion */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-text">Command Center — which watchers fired</p>
        <ContributionBars contributions={result.contributions} />
      </div>

      {/* Degradation */}
      {d && (
        <div className="flex flex-wrap gap-2 text-xs">
          {d.store_unavailable && (
            <span className="rounded-full border border-risk-critical/30 bg-risk-critical/10 px-2.5 py-0.5 text-risk-critical">
              feature store unavailable
            </span>
          )}
          {d.user_history && (
            <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-text-muted">
              no prior history for this entity (cold start)
            </span>
          )}
          {d.bank_context_used && (
            <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-text-muted">
              bank-supplied context used
            </span>
          )}
        </div>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-text-muted hover:text-text">
          Raw model response
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded-[var(--radius-input)] border border-border bg-surface p-3 text-[11px] leading-relaxed text-text">
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </div>
  );
}
