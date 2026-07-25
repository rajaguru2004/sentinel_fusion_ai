'use client';

import { CONTRIBUTION_LABELS, fuseNoisyOr, type Contributions } from '@/lib/sentinel';

/**
 * Shows the fused score being built (ENHANCEMENTS.md §5).
 *
 * The "Command Center" metaphor claims independent watchers combine into one
 * verdict. This is that claim's receipt: every firing watcher's calibrated
 * probability, the weight applied to it, and the running noisy-OR product that
 * produces `risk_score`.
 *
 * The recomputed total is compared against the model's own `risk_score`. When
 * they disagree it says so rather than hiding it — a mismatch is real
 * information (a policy floor was applied after fusion, or these weights have
 * drifted from the trained bundle), and silently showing only the server value
 * would waste the check.
 */
export function FusionMath({
  contributions,
  riskScore,
}: {
  contributions: Contributions;
  riskScore: number;
}) {
  const { terms, risk } = fuseNoisyOr(contributions);
  if (!terms.length) return null;

  // Tolerance covers float noise and the model's own rounding, not real drift.
  const matches = Math.abs(risk - riskScore) < 0.005;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text">How the watchers combined</p>

      <div className="overflow-x-auto rounded-[var(--radius-input)] border border-border bg-surface">
        <table className="w-full min-w-[26rem] text-xs">
          <thead>
            <tr className="border-b border-border text-text-muted">
              <th className="px-3 py-2 text-left font-medium">Watcher</th>
              <th className="px-3 py-2 text-right font-medium">pᵢ</th>
              <th className="px-3 py-2 text-right font-medium">wᵢ</th>
              <th className="px-3 py-2 text-right font-medium">wᵢ·pᵢ</th>
              <th className="px-3 py-2 text-right font-medium">1 − wᵢ·pᵢ</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {terms.map((t) => (
              <tr key={t.key} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-1.5 font-sans text-text">{CONTRIBUTION_LABELS[t.key]}</td>
                <td className="px-3 py-1.5 text-right text-text">{t.p.toFixed(4)}</td>
                <td className="px-3 py-1.5 text-right text-text-muted">{t.weight.toFixed(2)}</td>
                <td className="px-3 py-1.5 text-right text-text">{t.contribution.toFixed(4)}</td>
                <td className="px-3 py-1.5 text-right text-text-muted">
                  {(1 - t.contribution).toFixed(4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="font-mono text-xs text-text">
        risk = 1 − Π(1 − wᵢ·pᵢ) ={' '}
        <span className="font-semibold">{risk.toFixed(4)}</span>
        {matches ? (
          <span className="ml-2 font-sans text-[11px] text-risk-low">
            ✓ matches the model&apos;s risk_score
          </span>
        ) : (
          <span className="ml-2 font-sans text-[11px] text-risk-medium">
            model reported {riskScore.toFixed(4)} — a post-fusion policy floor was applied, or
            these weights differ from the trained bundle
          </span>
        )}
      </p>

      <p className="text-[11px] leading-relaxed text-text-muted">
        Union-of-threats: one confident watcher is enough to carry the verdict, and several weak
        ones accumulate instead of averaging each other out. A watcher that did not fire is
        skipped entirely — not treated as a vote of zero.
      </p>
    </div>
  );
}
