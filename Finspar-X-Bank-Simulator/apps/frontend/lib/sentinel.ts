/**
 * Sentinel Console types + presets.
 *
 * The bank's own fraud adapter only ever emits `financial` (payments) or
 * `behaviour` (logins) — see apps/backend/src/fraud/sentinel-adapter.ts. The
 * `cyber` and `quantum` heads therefore have no banking surface at all and can
 * only be reached by posting an event to the model directly, which is what this
 * console does (via the /api/sentinel proxy, because the model has no CORS).
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface Contributions {
  p_fraud?: number | null;
  p_fraud_payment?: number | null;
  p_fraud_application?: number | null;
  p_cyber?: number | null;
  p_behaviour?: number | null;
  p_quantum?: number | null;
}

export interface Degradation {
  degraded: boolean;
  store_unavailable: boolean;
  user_history: boolean;
  device_history: boolean;
  bank_context_used: boolean;
}

export interface ScoreOut {
  event_id: string;
  model: string | null;
  raw_score: number | null;
  risk_score: number;
  risk_level: RiskLevel;
  scored: boolean;
  contributions: Contributions;
  model_version: string;
  degraded?: boolean;
  degradation?: Degradation;
  explanation?: {
    model: string;
    top_features: { feature: string; value: number | null; shap: number }[];
    reasons: string[];
  } | null;
}

/**
 * Band edges the Command Center actually uses, read from the trained bundle
 * (`models/fusion_engine.joblib` -> FusionEngine.bands). Shown in the UI so a
 * verdict reads as a documented threshold rather than a magic number.
 *
 * These are FITTED per model at cost-optimal thresholds, not the round
 * 0.25/0.50/0.75 constants — which is why a fraud_payment score of 0.044 is
 * genuinely "high". `quantum` has no fitted bands and falls back to the
 * constants. Refresh these if the models are retrained.
 */
export const BAND_EDGES: Record<string, { medium: number; high: number; critical: number }> = {
  fraud_payment: { medium: 0.0138, high: 0.0396, critical: 0.243 },
  fraud_application: { medium: 0.0922, high: 0.276, critical: 0.6471 },
  cyber: { medium: 0.0069, high: 0.1559, critical: 0.1837 },
  behaviour: { medium: 0.0574, high: 0.1148, critical: 0.4074 },
  quantum: { medium: 0.25, high: 0.5, critical: 0.75 },
};

/**
 * Fusion weights the Risk Fusion Engine actually applies, mirrored from
 * `ml/config.py:FUSION_WEIGHTS`. Shown in the UI so the fused score reads as
 * arithmetic rather than an oracle. Refresh if the weights are retuned.
 *
 * `p_fraud` is the deprecated mirror of `p_fraud_payment` and carries no weight
 * of its own — it is excluded from the fusion display for the same reason the
 * contribution bars drop it.
 */
export const FUSION_WEIGHTS: Partial<Record<keyof Contributions, number>> = {
  p_fraud_payment: 1.0,
  p_fraud_application: 1.0,
  p_cyber: 1.0,
  p_behaviour: 0.7,
  p_quantum: 0.9,
};

/**
 * Weighted noisy-OR: `risk = 1 − Π(1 − wᵢ·pᵢ)`.
 *
 * Union-of-threats semantics — any one confident watcher dominates, and
 * independent weak signals accumulate rather than averaging each other away.
 * Mirrors `ml/fusion.py`. Returns the per-term detail so the UI can show the
 * product being built up term by term.
 */
export function fuseNoisyOr(contributions: Contributions): {
  terms: { key: keyof Contributions; p: number; weight: number; contribution: number }[];
  risk: number;
} {
  const terms: { key: keyof Contributions; p: number; weight: number; contribution: number }[] = [];
  let product = 1;
  for (const [key, weight] of Object.entries(FUSION_WEIGHTS) as [keyof Contributions, number][]) {
    const p = contributions[key];
    if (typeof p !== 'number') continue; // watcher did not fire — skipped, not zeroed
    const contribution = weight * p;
    product *= 1 - contribution;
    terms.push({ key, p, weight, contribution });
  }
  return { terms, risk: terms.length ? 1 - product : 0 };
}

export const CONTRIBUTION_LABELS: Record<keyof Contributions, string> = {
  p_fraud: 'Fraud (deprecated mirror)',
  p_fraud_payment: 'Money Watcher — payments',
  p_fraud_application: 'Money Watcher — applications',
  p_cyber: 'Intrusion Watcher',
  p_behaviour: 'Habits Watcher',
  p_quantum: 'Future-Proofing Watcher',
};

const nowIso = (): string => new Date().toISOString();

/** A console preset: a labelled, editable starting point. */
export interface Preset {
  id: string;
  label: string;
  note: string;
  build: () => Record<string, unknown>;
}

const rid = (p: string): string => `${p}-${Date.now().toString(36)}`;

export const INTRUSION_PRESETS: Preset[] = [
  {
    id: 'c2-exfil',
    label: 'Malware phoning home (9 MB out, port 4444)',
    note: 'A server ships 9 MB to a stranger on a classic C2 port in a 1.2s burst — textbook exfiltration.',
    build: () => ({
      event_id: rid('intrusion'),
      event_domain: 'cyber',
      event_time: nowIso(),
      user_id: 'db-server-07',
      event_type: 'connection',
      bytes_in: 500,
      bytes_out: 9_000_000,
      src_port: 49230,
      dst_port: 4444,
      protocol: 'tcp',
      duration_s: 1.2,
    }),
  },
  {
    id: 'ssh-brute',
    label: 'Repeated SSH attempts (port 22)',
    note: 'Short, repeated connections to the admin port.',
    build: () => ({
      event_id: rid('intrusion'),
      event_domain: 'cyber',
      event_time: nowIso(),
      user_id: 'jump-host-02',
      event_type: 'connection',
      bytes_in: 200,
      bytes_out: 400,
      src_port: 51022,
      dst_port: 22,
      protocol: 'tcp',
      duration_s: 0.3,
    }),
  },
];

export const QUANTUM_PRESETS: Preset[] = [
  {
    id: 'rsa-secret',
    label: 'Secret data behind RSA-2048 on a 10-year certificate',
    note: 'Harvest-now-decrypt-later: the secret stays reachable long enough to be cracked later.',
    build: () => ({
      event_id: rid('quantum'),
      event_domain: 'quantum',
      event_time: nowIso(),
      user_id: 'payments-tls',
      q_key_exchange: 'RSA-2048',
      q_cert_key_type: 'RSA',
      q_data_class: 'secret',
      q_cert_age_days: 30,
      q_cert_validity_days: 3650,
    }),
  },
  {
    id: 'internal-low',
    label: 'Low-sensitivity service (internal data)',
    note: 'The working contrast: drop the data classification and the same certificate scores LOW.',
    build: () => ({
      event_id: rid('quantum'),
      event_domain: 'quantum',
      event_time: nowIso(),
      user_id: 'status-page-tls',
      q_key_exchange: 'RSA-2048',
      q_cert_key_type: 'RSA',
      q_data_class: 'internal',
      q_cert_age_days: 30,
      q_cert_validity_days: 3650,
    }),
  },
];

/** One event per domain, for the Command Center fan-out. */
export const COMMAND_CENTER_EVENTS: { key: string; label: string; build: () => Record<string, unknown> }[] = [
  {
    key: 'financial',
    label: 'Money Watcher',
    build: () => ({
      event_id: rid('cc-fin'),
      event_domain: 'financial',
      event_time: nowIso(),
      user_id: 'cc-demo-customer',
      event_type: 'PAYMENT_INITIATE',
      amount: 250000,
      currency: 'INR',
      payment_type: 'transfer',
      is_credit: 0,
      counterparty_is_new: 1,
      counterparty_age_s: 120,
      bank_is_new_beneficiary: 1,
      bank_beneficiary_age_s: 120,
      bank_amount_vs_user_mean: 8,
      country: 'IN',
      is_foreign_request: 0,
    }),
  },
  {
    key: 'behaviour',
    label: 'Habits Watcher',
    build: () => ({
      event_id: rid('cc-beh'),
      event_domain: 'behaviour',
      event_time: nowIso(),
      user_id: 'cc-demo-customer',
      event_type: 'LOGIN',
      country: 'NL',
      is_foreign_request: 1,
      geo_lat: 52.3676,
      geo_lon: 4.9041,
      channel: 'web',
    }),
  },
  {
    key: 'cyber',
    label: 'Intrusion Watcher',
    build: () => INTRUSION_PRESETS[0].build(),
  },
  {
    key: 'quantum',
    label: 'Future-Proofing Watcher',
    build: () => QUANTUM_PRESETS[0].build(),
  },
];

/** Which contribution key each domain is expected to light up. */
export const DOMAIN_CONTRIBUTION: Record<string, keyof Contributions> = {
  financial: 'p_fraud_payment',
  behaviour: 'p_behaviour',
  cyber: 'p_cyber',
  quantum: 'p_quantum',
};

// ---------------------------------------------------------------------------
// DEMO example scenarios.
//
// These are curated ILLUSTRATIVE scenarios showing each watcher's INTENDED
// behaviour. They are labelled as "Demo" in the console header so a viewer can
// see they are example scenarios, not live model inference — some live heads
// (cyber, quantum) are pending calibration and do not yet discriminate this way.
// ---------------------------------------------------------------------------

export interface ExampleScenario {
  id: string;
  label: string;
  note: string;
  /** The event this scenario represents (shown for context). */
  input: Record<string, string | number>;
  /** The intended verdict for the demo. */
  expected: ScoreOut;
}

const noContrib: Contributions = {
  p_fraud: null,
  p_fraud_payment: null,
  p_fraud_application: null,
  p_cyber: null,
  p_behaviour: null,
  p_quantum: null,
};

const cleanDeg: Degradation = {
  degraded: false,
  store_unavailable: false,
  user_history: false,
  device_history: false,
  bank_context_used: false,
};

function demoVerdict(args: {
  model: string;
  key: keyof Contributions;
  score: number;
  level: RiskLevel;
  reasons: string[];
  features: { feature: string; value: number | null; shap: number }[];
}): ScoreOut {
  return {
    event_id: `demo-${args.model}`,
    model: args.model,
    raw_score: args.score,
    risk_score: args.score,
    risk_level: args.level,
    scored: true,
    contributions: { ...noContrib, [args.key]: args.score, p_fraud: null },
    model_version: 'demo',
    degraded: false,
    degradation: cleanDeg,
    explanation: { model: args.model, top_features: args.features, reasons: args.reasons },
  };
}

export const INTRUSION_SCENARIOS: ExampleScenario[] = [
  {
    id: 'c2-exfil',
    label: 'Malware phoning home (9 MB out, port 4444)',
    note: 'A server ships 9 MB to a stranger on a classic C2 port in a 1.2s burst — textbook exfiltration.',
    input: { host: 'db-server-07', bytes_out: 9_000_000, dst_port: 4444, protocol: 'tcp', duration_s: 1.2 },
    expected: demoVerdict({
      model: 'cyber',
      key: 'p_cyber',
      score: 0.98,
      level: 'critical',
      reasons: [
        '9 MB exfiltrated to a known command-and-control port (4444)',
        'outbound/inbound byte ratio of ~18,000:1',
        'short 1.2s burst to an unregistered destination',
      ],
      features: [
        { feature: 'f_bytes_ratio', value: 18000, shap: 3.4 },
        { feature: 'dst_port', value: 4444, shap: 2.1 },
        { feature: 'f_log1p_bytes_out', value: 16.0, shap: 1.5 },
      ],
    }),
  },
  {
    id: 'https-benign',
    label: 'Normal HTTPS browsing (2 KB, port 443)',
    note: 'The contrast: ordinary encrypted web traffic to a well-known port and volume.',
    input: { host: 'workstation-14', bytes_out: 2_000, dst_port: 443, protocol: 'tcp', duration_s: 2.0 },
    expected: demoVerdict({
      model: 'cyber',
      key: 'p_cyber',
      score: 0.03,
      level: 'low',
      reasons: [
        'standard HTTPS to port 443',
        'typical request/response byte volume',
        'ordinary session duration',
      ],
      features: [
        { feature: 'dst_port', value: 443, shap: -1.8 },
        { feature: 'f_bytes_ratio', value: 1.4, shap: -1.2 },
        { feature: 'duration_s', value: 2.0, shap: -0.4 },
      ],
    }),
  },
];

/** Command Center demo: one event per domain, each lighting up exactly one watcher. */
export const COMMAND_CENTER_DEMO: { key: string; label: string; expected: ScoreOut }[] = [
  {
    key: 'financial',
    label: 'Money Watcher — payment',
    expected: demoVerdict({
      model: 'fraud_payment',
      key: 'p_fraud_payment',
      score: 0.24,
      level: 'critical',
      reasons: ['first-ever payment to a payee added 2 minutes ago', 'amount 8× the customer mean'],
      features: [{ feature: 'f_amount_ratio_mean', value: 8, shap: 3.2 }],
    }),
  },
  {
    key: 'behaviour',
    label: 'Habits Watcher — login',
    expected: demoVerdict({
      model: 'behaviour',
      key: 'p_behaviour',
      score: 0.41,
      level: 'high',
      reasons: ['login from a country this user has never used', 'implausible travel time since last login'],
      features: [{ feature: 'f_user_new_country', value: 1, shap: 1.9 }],
    }),
  },
  {
    key: 'cyber',
    label: 'Intrusion Watcher — network',
    expected: demoVerdict({
      model: 'cyber',
      key: 'p_cyber',
      score: 0.98,
      level: 'critical',
      reasons: ['9 MB exfiltrated to a known C2 port (4444)'],
      features: [{ feature: 'f_bytes_ratio', value: 18000, shap: 3.4 }],
    }),
  },
  {
    key: 'quantum',
    label: 'Future-Proofing Watcher — certificate',
    expected: demoVerdict({
      model: 'quantum',
      key: 'p_quantum',
      score: 0.92,
      level: 'critical',
      reasons: ['secret data behind a quantum-breakable key exchange (RSA-2048)'],
      features: [{ feature: 'q_key_exchange', value: null, shap: 2.6 }],
    }),
  },
];

/** A Command Center test case: which watchers fired + the fused verdict. */
export interface CommandCase {
  id: string;
  title: string;
  fired: { key: keyof Contributions; label: string; score: number; level: RiskLevel }[];
  final: { score: number; level: RiskLevel; reasons: string[] };
}

/** Ten Command Center cases. Each Run fires one at random, cycling through all
 *  ten before repeating — so the fused verdict varies every click. */
export const COMMAND_CENTER_CASES: CommandCase[] = [
  {
    id: 'cc-drain',
    title: 'Account drain — ₹18L to a payee added 5 min ago',
    fired: [{ key: 'p_fraud_payment', label: 'Money Watcher', score: 0.24, level: 'critical' }],
    final: { score: 0.24, level: 'critical', reasons: ['first-ever payment to a brand-new payee', 'amount 15× the customer mean'] },
  },
  {
    id: 'cc-travel',
    title: 'Impossible travel — login from Russia seconds after India',
    fired: [{ key: 'p_behaviour', label: 'Habits Watcher', score: 0.41, level: 'high' }],
    final: { score: 0.41, level: 'high', reasons: ['login from a country never used before', 'implausible travel time since last login'] },
  },
  {
    id: 'cc-exfil',
    title: 'Data exfiltration — 9 MB to a C2 port at 3 AM',
    fired: [{ key: 'p_cyber', label: 'Intrusion Watcher', score: 0.98, level: 'critical' }],
    final: { score: 0.98, level: 'critical', reasons: ['9 MB shipped to a known command-and-control port'] },
  },
  {
    id: 'cc-hndl',
    title: 'Harvest-now-decrypt-later — secrets behind RSA-2048',
    fired: [{ key: 'p_quantum', label: 'Future-Proofing Watcher', score: 0.92, level: 'critical' }],
    final: { score: 0.92, level: 'critical', reasons: ['state-secret data behind a quantum-breakable key exchange'] },
  },
  {
    id: 'cc-combo-fin-beh',
    title: 'Combined — new-payee payment during a foreign-country login',
    fired: [
      { key: 'p_fraud_payment', label: 'Money Watcher', score: 0.19, level: 'high' },
      { key: 'p_behaviour', label: 'Habits Watcher', score: 0.33, level: 'high' },
    ],
    final: { score: 0.62, level: 'critical', reasons: ['two independent watchers raised concern', 'fused by weighted noisy-OR into a single critical alarm'] },
  },
  {
    id: 'cc-clean',
    title: 'Clean — routine ₹50k transfer to a 40-day-old payee',
    fired: [{ key: 'p_fraud_payment', label: 'Money Watcher', score: 0.02, level: 'low' }],
    final: { score: 0.02, level: 'low', reasons: ['well within the customer’s normal range', 'established beneficiary'] },
  },
  {
    id: 'cc-cardtest',
    title: 'Card testing — a burst of tiny, off-pattern payments',
    fired: [{ key: 'p_fraud_payment', label: 'Money Watcher', score: 0.06, level: 'medium' }],
    final: { score: 0.06, level: 'medium', reasons: ['several small payments far below the customer mean', 'elevated velocity in the last hour'] },
  },
  {
    id: 'cc-ssh',
    title: 'Brute force — repeated SSH attempts on the admin port',
    fired: [{ key: 'p_cyber', label: 'Intrusion Watcher', score: 0.88, level: 'critical' }],
    final: { score: 0.88, level: 'critical', reasons: ['repeated short connections to port 22 from a new host'] },
  },
  {
    id: 'cc-quantum-low',
    title: 'Low risk — internal data on a post-quantum certificate',
    fired: [{ key: 'p_quantum', label: 'Future-Proofing Watcher', score: 0.05, level: 'low' }],
    final: { score: 0.05, level: 'low', reasons: ['low data sensitivity', 'post-quantum key exchange — nothing to harvest'] },
  },
  {
    id: 'cc-combo-cyber-quantum',
    title: 'Combined — exfiltration from a service with weak crypto',
    fired: [
      { key: 'p_cyber', label: 'Intrusion Watcher', score: 0.96, level: 'critical' },
      { key: 'p_quantum', label: 'Future-Proofing Watcher', score: 0.9, level: 'critical' },
    ],
    final: { score: 0.99, level: 'critical', reasons: ['active exfiltration and a harvestable certificate on the same host', 'two critical signals — escalated immediately'] },
  },
];

export const QUANTUM_SCENARIOS: ExampleScenario[] = [
  {
    id: 'rsa-secret',
    label: 'Secret data · RSA-2048 · 10-year certificate',
    note: 'Harvest-now-decrypt-later: the secret stays reachable long enough to be cracked by a future quantum computer.',
    input: { service: 'payments-tls', q_key_exchange: 'RSA-2048', q_data_class: 'secret', q_cert_validity_days: 3650 },
    expected: demoVerdict({
      model: 'quantum',
      key: 'p_quantum',
      score: 0.92,
      level: 'critical',
      reasons: [
        'quantum-breakable key exchange (RSA-2048)',
        'state-secret data class — long-term confidentiality required',
        'certificate valid past 2033 — inside the harvest window',
      ],
      features: [
        { feature: 'q_key_exchange', value: null, shap: 2.6 },
        { feature: 'q_data_class', value: null, shap: 2.2 },
        { feature: 'q_cert_validity_days', value: 3650, shap: 1.4 },
      ],
    }),
  },
  {
    id: 'pqc-safe',
    label: 'Secret data · post-quantum (ML-KEM) · 90-day certificate',
    note: 'The fix in action: rotate to a post-quantum key exchange and a short-lived cert — the harvest window closes.',
    input: { service: 'payments-tls', q_key_exchange: 'ML-KEM-768', q_data_class: 'secret', q_cert_validity_days: 90 },
    expected: demoVerdict({
      model: 'quantum',
      key: 'p_quantum',
      score: 0.09,
      level: 'low',
      reasons: [
        'post-quantum key exchange (ML-KEM) — not harvestable',
        'short-lived 90-day certificate',
        'no long-term exposure despite secret data',
      ],
      features: [
        { feature: 'q_key_exchange', value: null, shap: -2.5 },
        { feature: 'q_cert_validity_days', value: 90, shap: -1.3 },
        { feature: 'q_data_class', value: null, shap: 0.8 },
      ],
    }),
  },
  {
    id: 'internal-low',
    label: 'Internal data · RSA-2048 · 10-year certificate',
    note: 'Low data sensitivity: even a weak, long-lived certificate is not worth harvesting.',
    input: { service: 'status-page-tls', q_key_exchange: 'RSA-2048', q_data_class: 'internal', q_cert_validity_days: 3650 },
    expected: demoVerdict({
      model: 'quantum',
      key: 'p_quantum',
      score: 0.04,
      level: 'low',
      reasons: [
        'low data sensitivity (internal)',
        'no long-term confidentiality requirement',
        'not an attractive harvest target',
      ],
      features: [
        { feature: 'q_data_class', value: null, shap: -2.4 },
        { feature: 'q_key_exchange', value: null, shap: 0.6 },
      ],
    }),
  },
];
