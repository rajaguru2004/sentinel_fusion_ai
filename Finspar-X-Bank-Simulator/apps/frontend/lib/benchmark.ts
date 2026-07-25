/**
 * Scenarios and types for the Model Benchmark screen (`/sentinel/benchmark`).
 *
 * Two deliberately different stories:
 *   - Counterfactual = DEPTH. One event, analysed exhaustively. Single digits
 *     per second, because each request runs a SHAP explain plus a re-score of
 *     ~10–15 candidate scenarios. That cost IS the feature.
 *   - Batch = SCALE. Up to 1000 events in one call, measured end to end.
 *
 * Presenting them as one number would flatter neither. Presented as depth vs
 * scale, both read as intentional.
 */

export interface TimedEnvelope<T> {
  data: T;
  timing: {
    count: number;
    elapsedMs: number;
    perSecond: number;
    msPerEvent: number;
    measuredAt: string;
  };
}

// --------------------------------------------------------------- counterfactual

export interface FeatureChange {
  feature: string;
  original_value: number | string | null;
  recommended_value: number | string | null;
  delta: number | null;
  unit: string | null;
  change_description: string;
}

export interface Counterfactual {
  rank: number;
  predicted_risk_score: number;
  predicted_risk_level: string;
  risk_reduction_pct: number;
  confidence: number;
  actionability_score: number;
  changes: FeatureChange[];
  explanation: string;
}

export interface CounterfactualResult {
  event_id: string;
  original_risk_score: number;
  original_risk_level: string;
  target_risk_level: string;
  model: string | null;
  counterfactuals: Counterfactual[];
}

export interface CfScenario {
  id: string;
  label: string;
  note: string;
  targetRiskLevel: 'low' | 'medium';
  build: () => Record<string, unknown>;
}

const rid = (p: string): string => `${p}-${Date.now().toString(36)}`;

export const CF_SCENARIOS: CfScenario[] = [
  {
    id: 'new-payee-drain',
    label: 'Large transfer to a brand-new payee',
    note: 'The classic account-drain shape: most of the balance, to someone added minutes ago. Ask the model what would have made this acceptable.',
    targetRiskLevel: 'low',
    build: () => ({
      event_id: rid('cf-drain'),
      event_domain: 'financial',
      event_type: 'PAYMENT_INITIATE',
      user_id: 'bench-customer-01',
      amount: 50000.0,
      balance_before: 55000.0,
      balance_after: 5000.0,
      counterparty_is_new: 1,
      counterparty_age_s: 180,
      bank_is_new_beneficiary: 1,
      bank_beneficiary_age_s: 180,
      bank_amount_vs_user_mean: 12,
      country: 'IN',
      is_foreign_request: 0,
      currency: 'INR',
      payment_type: 'transfer',
      is_credit: 0,
    }),
  },
  {
    id: 'foreign-device',
    label: 'Foreign request from an unrecognised device',
    note: 'Two independent signals at once — location and device. Shows which one the model would rather you fixed.',
    targetRiskLevel: 'low',
    build: () => ({
      event_id: rid('cf-foreign'),
      event_domain: 'financial',
      event_type: 'PAYMENT_INITIATE',
      user_id: 'bench-customer-02',
      amount: 22000.0,
      balance_before: 90000.0,
      balance_after: 68000.0,
      counterparty_is_new: 1,
      counterparty_age_s: 900,
      device_is_new: 1,
      is_foreign_request: 1,
      country: 'US',
      email_is_free: 1,
      currency: 'INR',
      payment_type: 'transfer',
      is_credit: 0,
    }),
  },
  {
    id: 'oversized-vs-mean',
    label: 'Payment far above the customer average',
    note: 'One dominant driver. The recommendation should be a specific amount, not a vague "spend less".',
    targetRiskLevel: 'medium',
    build: () => ({
      event_id: rid('cf-amount'),
      event_domain: 'financial',
      event_type: 'PAYMENT_INITIATE',
      user_id: 'bench-customer-03',
      amount: 180000.0,
      balance_before: 200000.0,
      balance_after: 20000.0,
      counterparty_is_new: 0,
      counterparty_age_s: 40 * 86400,
      bank_amount_vs_user_mean: 24,
      country: 'IN',
      is_foreign_request: 0,
      currency: 'INR',
      payment_type: 'transfer',
      is_credit: 0,
    }),
  },
];

// ----------------------------------------------------------------------- batch

export interface ScoreRow {
  event_id: string;
  risk_score: number;
  risk_level: string;
  model: string | null;
  scored: boolean;
}
export interface BatchResult {
  results: ScoreRow[];
}

export const BATCH_SIZES = [100, 250, 500, 1000] as const;
export type BatchSize = (typeof BATCH_SIZES)[number];

/**
 * How many events in a batch should be built to trip the model.
 *
 * Anchored to the two targets the demo calls for: ~4 alerts in 100 events, and
 * ~150 in 1000. Note those are different RATES (≈4% and ≈15%), not one rate —
 * so intermediate sizes interpolate across the span rather than picking either.
 */
export function alertTarget(size: number): number {
  if (size <= 100) return 4;
  if (size >= 1000) return 150;
  return Math.round(4 + ((size - 100) / 900) * (150 - 4));
}

/**
 * Generate a realistic mixed batch.
 *
 * Two things this has to get right, both learned by probing the model:
 *
 * 1. **Absolute amount is the dominant driver.** Probing the live model, with
 *    everything else held maximally benign: ≤ ₹600 scores `low`, ≥ ₹1000 jumps
 *    to a `medium` plateau at 0.0248 and stays there all the way to ₹4000.
 *    Payee age, balance and amount-vs-mean barely move the needle by comparison
 *    (0.0040 vs 0.0112 — all still `low`). So benign amounts are capped under
 *    that cliff. The bands are tight by design: `low` is anything under 0.0138,
 *    fitted at a cost ratio that prices a missed fraud at 20× a false alarm.
 *
 * 2. **One user per event, or velocity swamps everything.** An earlier version
 *    reused a pool of 50 ids, which in a 1000-event batch gave every user 20
 *    payments in the same second. The store's velocity features read that as an
 *    attack and pushed ordinary events to HIGH — the distribution was measuring
 *    the generator, not the traffic. Each event now gets its own customer, so a
 *    verdict reflects only that event's own attributes.
 *
 * Ids are scoped to the run, so every run starts from the same cold-start
 * position and is reproducible. Fixed ids let history accumulate across runs,
 * which quietly moved the distribution between one demo and the next.
 */
export function buildBatch(size: number): Record<string, unknown>[] {
  const run = Date.now().toString(36);
  const alerts = alertTarget(size);
  // Spread the alerts evenly instead of clustering them at the front, so the
  // sampled rows on screen show a realistic mix.
  const stride = size / alerts;

  return Array.from({ length: size }, (_, i) => {
    const suspicious = Math.floor(i % stride) === 0 && Math.floor(i / stride) < alerts;
    const base = {
      event_id: `bench-${run}-${i}`,
      event_domain: 'financial',
      event_type: 'PAYMENT_INITIATE',
      user_id: `bench-${run}-u${i}`,
      currency: 'INR',
      payment_type: 'transfer',
      is_credit: 0,
    };

    if (suspicious) {
      const amount = 85_000 + (i % 40) * 1_800;
      return {
        ...base,
        amount,
        balance_before: amount + 4_000 + (i % 7) * 500,
        balance_after: 4_000 + (i % 7) * 500,
        counterparty_is_new: 1,
        counterparty_age_s: 90 + (i % 11) * 30,
        bank_is_new_beneficiary: 1,
        bank_beneficiary_age_s: 90 + (i % 11) * 30,
        bank_amount_vs_user_mean: 12 + (i % 9),
        is_foreign_request: i % 3 === 0 ? 1 : 0,
        country: i % 3 === 0 ? 'US' : 'IN',
        email_is_free: 1,
      };
    }

    // Routine traffic. Amount stays under the ~₹600 cliff found by probing, so
    // these land in `low` rather than on the 0.0248 medium plateau.
    const amount = 150 + (i % 90) * 5;
    const balance = 420_000 + (i % 60) * 8_000;
    return {
      ...base,
      amount,
      balance_before: balance,
      balance_after: balance - amount,
      counterparty_is_new: 0,
      counterparty_age_s: (210 + (i % 160)) * 86_400,
      bank_is_new_beneficiary: 0,
      bank_beneficiary_age_s: (210 + (i % 160)) * 86_400,
      bank_amount_vs_user_mean: 0.15 + ((i % 40) * 0.01),
      is_foreign_request: 0,
      country: 'IN',
      email_is_free: 0,
    };
  });
}

/** Count results by risk level, for the distribution bar. */
export function levelCounts(rows: ScoreRow[]): Record<string, number> {
  const out: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const r of rows) if (r.risk_level in out) out[r.risk_level]++;
  return out;
}
