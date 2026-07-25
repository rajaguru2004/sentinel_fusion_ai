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
