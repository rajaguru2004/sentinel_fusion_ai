'use client';

import { featureLabel } from '@/lib/reasons';

export interface TopFeature {
  feature: string;
  value: number | null;
  shap: number;
}

/** Compact number for the "actual value" column — 9000000 -> 9M, 0.0138 -> 0.0138. */
function formatValue(v: number | null): string {
  if (v === null || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (abs >= 1) return String(Number(v.toFixed(2)));
  return String(Number(v.toFixed(4)));
}

/**
 * Signed SHAP contribution chart (ENHANCEMENTS.md §5).
 *
 * The model already returns `explanation.top_features` with a SHAP value per
 * feature; until now the card rendered only the text `reasons` and threw the
 * numbers away. This turns "why" from an assertion into an audit: each row names
 * the feature, the customer's actual value, and the signed push it applied.
 *
 * Bars diverge from a centre axis — right/red pushes toward fraud, left/green
 * pulls toward legitimate — because the sign is the whole point. A one-directional
 * bar chart would hide that some features actively *vouched* for the customer.
 */
export function ShapWaterfall({ features }: { features: TopFeature[] }) {
  if (!features?.length) return null;

  // Scale every bar against the strongest absolute push, so the biggest driver
  // fills the half-width and the rest are read relative to it.
  const max = Math.max(...features.map((f) => Math.abs(f.shap)), 0.0001);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-text">What drove the score</p>
        <p className="text-[11px] text-text-muted">
          <span className="text-risk-critical">■</span> raises risk ·{' '}
          <span className="text-risk-low">■</span> lowers it
        </p>
      </div>

      <div className="space-y-1.5">
        {features.map((f) => {
          const pct = (Math.abs(f.shap) / max) * 50; // half the track at most
          const raises = f.shap >= 0;
          return (
            <div key={f.feature} className="flex items-center gap-2">
              <span
                className="w-52 shrink-0 truncate text-xs text-text-muted"
                title={f.feature}
              >
                {featureLabel(f.feature)}
              </span>

              <span className="w-14 shrink-0 text-right font-mono text-[11px] text-text">
                {formatValue(f.value)}
              </span>

              {/* Diverging track: centre line is "no influence". */}
              <div className="relative h-2.5 flex-1 rounded-full bg-bg">
                <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                <div
                  className={`absolute inset-y-0 rounded-full ${
                    raises ? 'bg-risk-critical' : 'bg-risk-low'
                  }`}
                  style={
                    raises
                      ? { left: '50%', width: `${pct}%` }
                      : { right: '50%', width: `${pct}%` }
                  }
                />
              </div>

              <span
                className={`w-14 shrink-0 text-right font-mono text-[11px] ${
                  raises ? 'text-risk-critical' : 'text-risk-low'
                }`}
              >
                {raises ? '+' : ''}
                {f.shap.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-text-muted">
        SHAP values are log-odds contributions: they say how much each feature moved this
        decision away from the model&apos;s baseline, not what fraction of the score it owns.
        The value column is the customer&apos;s actual figure for that feature.
      </p>
    </div>
  );
}
