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

// --------------------------------------------------------- applying a recommendation

export interface AppliedEvent {
  /** The event to re-score: the analysed event with the recommendation merged in. */
  event: Record<string, unknown>;
  /** Fields the model explicitly recommended changing. */
  changed: string[];
  /** Fields WE adjusted to keep the event internally coherent. Always shown. */
  derived: string[];
}

/**
 * Build the event that a recommendation implies, ready to re-score.
 *
 * `feature` names come back from the model matching the event's own keys
 * (`amount`, `counterparty_age_s`, …), so applying a recommendation is a
 * shallow merge of `recommended_value`.
 *
 * The subtlety is `deriveDependents`, and it defaults OFF.
 *
 * The model recommends ONE feature at a time and leaves correlated fields
 * untouched, which can produce an event that contradicts itself — e.g.
 * `counterparty_age_s: 604800` (a week old) sitting next to
 * `counterparty_is_new: 1`. Tidying that up is tempting, but measured against
 * the live model the plain merge reproduces the counterfactual's own
 * `predicted_risk_score` EXACTLY (5 of 5 recommendations across the scenarios,
 * to 4dp), because it is the same single-feature perturbation the model scored
 * internally. Deriving the dependants scores strictly better — the drain
 * scenario's rank 2 predicts 0.6250, applies raw at 0.6250, and applies
 * consistent at 0.5057 — since removing the contradiction removes real risk
 * the model never claimed to have removed.
 *
 * So: off by default, because "apply the recommendation" should mean exactly
 * the recommendation and nothing else, and because a prediction that lands on
 * its own number is the honest demonstration. On is offered as the "what would
 * really happen" view. Either way the caller is handed `derived` so the UI can
 * say precisely what was sent; nothing here is applied silently.
 */
export function applyCounterfactual(
  analysed: Record<string, unknown>,
  cf: Counterfactual,
  opts: { deriveDependents: boolean },
): AppliedEvent {
  const event = { ...analysed };
  const changed: string[] = [];
  const derived: string[] = [];

  const set = (key: string, value: unknown, into: string[]): void => {
    if (!(key in analysed) || event[key] === value) return;
    event[key] = value;
    if (!into.includes(key)) into.push(key);
  };

  for (const ch of cf.changes) {
    if (ch.recommended_value === null) continue;
    event[ch.feature] = ch.recommended_value;
    changed.push(ch.feature);
  }

  if (opts.deriveDependents) {
    for (const ch of cf.changes) {
      const value = ch.recommended_value;
      if (value === null) continue;

      // Amount moves the closing balance and the ratio to the customer's mean.
      if (ch.feature === 'amount' && typeof value === 'number') {
        const before = analysed.balance_before;
        if (typeof before === 'number') set('balance_after', before - value, derived);

        const original = analysed.amount;
        const ratio = analysed.bank_amount_vs_user_mean;
        if (typeof original === 'number' && original > 0 && typeof ratio === 'number') {
          set('bank_amount_vs_user_mean', round4((ratio * value) / original), derived);
        }
      }

      // Payee age: the two age fields describe the same payee, and "new" is a
      // function of that age rather than an independent fact.
      if ((ch.feature === 'counterparty_age_s' || ch.feature === 'bank_beneficiary_age_s') && typeof value === 'number') {
        const isNew = value < 3600 ? 1 : 0;
        set('counterparty_age_s', value, derived);
        set('bank_beneficiary_age_s', value, derived);
        set('counterparty_is_new', isNew, derived);
        set('bank_is_new_beneficiary', isNew, derived);
      }
    }
  }

  // A fresh id: the model dedups on event_id, and re-scoring under the analysed
  // event's id would return the original verdict instead of a new one.
  event.event_id = rid('cf-applied');

  // A fresh user_id too, and this one is subtle enough to be worth spelling out.
  //
  // Re-scoring against the analysed event's customer looks like the faithful
  // choice, but it is not: the applied event then arrives as that customer's
  // SECOND payment within seconds, and the velocity features price it as a
  // burst. Measured live, that alone was worth ~0.12 of risk — enough to swamp
  // the change being tested, and it compounded on every click, so a second
  // Apply scored worse than the first purely for being second.
  //
  // The counterfactual asks "what would have made THIS event acceptable", i.e.
  // it is a replacement for the original event, not a follow-up to it. A cold
  // customer puts the applied event in exactly the position the original
  // occupied — same history (none), same velocity (none) — which is what makes
  // the before/after numbers comparable at all.
  event.user_id = rid('cf-applied-u');

  return { event, changed, derived: derived.filter((d) => !changed.includes(d)) };
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

const rid = (p: string): string =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * NOTE ON `user_id`: it is run-scoped, for the same reason buildBatch() gives
 * every event its own customer.
 *
 * These scenarios used a fixed id per scenario, so every Analyse piled another
 * payment onto the same synthetic customer within seconds. The model's velocity
 * features read that as an attack: measured live, the drain scenario's own
 * baseline drifted 0.8846 -> 0.9362 over a dozen runs, and the third scenario
 * stopped returning any recommendation at all. The screen was measuring how
 * many times it had been demoed.
 *
 * A fresh customer per build makes every Analyse start from the same cold
 * position, and applyCounterfactual() mints another for the applied event so
 * the two sit at the same point in that customer's (empty) history.
 */
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
      user_id: rid('bench-customer-01'),
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
      user_id: rid('bench-customer-02'),
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
  // REMOVED: 'oversized-vs-mean' ("Payment far above the customer average").
  // It asked for a `medium` target on an event the model scores at 0.5057, and
  // medium for fraud_payment is < 0.0396 — unreachable, so the endpoint
  // returned zero recommendations every time and Analyse dead-ended on a "No
  // recommendation" card. Re-adding it needs a target the model can actually
  // hit; see BAND_EDGES in lib/sentinel.ts for the fitted thresholds.
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
