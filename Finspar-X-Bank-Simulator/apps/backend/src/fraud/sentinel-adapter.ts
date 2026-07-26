import { RiskLevel } from '@prisma/client';
import type { UnifiedEvent, RiskVerdict } from './scorer.interface';

/**
 * Wire types + mapping between the bank's UnifiedEvent / RiskVerdict and the
 * Sentinel Fusion AI v2 HTTP contract (sentinel_fusion_ai/service/schemas.py).
 *
 * The model's EventIn is `extra="forbid"` — we must send ONLY known fields and
 * omit anything undefined, or the request is rejected. Booleans map to 1|0 to
 * match the model's `int | None` signal fields.
 */

type Domain = 'financial' | 'behaviour';

/** Subset of the model's EventIn we currently populate. */
export interface SentinelEventIn {
  event_id: string;
  event_domain: Domain;
  event_time: string; // tz-aware ISO-8601 UTC
  user_id?: string;
  device_id?: string;
  event_type?: string;
  country?: string;
  is_foreign_request?: number;
  geo_lat?: number;
  geo_lon?: number;
  amount?: number;
  currency?: string;
  payment_type?: string;
  is_credit?: number;
  counterparty_id?: string;
  counterparty_is_new?: number;
  counterparty_age_s?: number;
  name_mismatch?: number;
  // Step 8 enrichment — richer trained signals.
  balance_before?: number;
  balance_after?: number;
  counterparty_balance_before?: number;
  counterparty_balance_after?: number;
  customer_age?: number;
  account_age_s?: number;
  income?: number;
  email_is_free?: number;
  channel?: string;
  device_os?: string;
  // Bank-computed signals — trained as an independent view AND the cold-store
  // fallback seed. Sent even when the model could recompute them itself.
  bank_txn_count_1h?: number;
  bank_amount_vs_user_mean?: number;
  bank_beneficiary_age_s?: number;
  bank_is_new_beneficiary?: number;
}

interface Contributions {
  p_fraud?: number | null;
  p_fraud_payment?: number | null;
  p_fraud_application?: number | null;
  p_cyber?: number | null;
  p_behaviour?: number | null;
  p_quantum?: number | null;
}

interface FeatureAttribution {
  feature: string;
  value: number | null;
  shap: number;
}

interface Explanation {
  model: string;
  top_features: FeatureAttribution[];
  reasons: string[];
}

interface Degradation {
  degraded: boolean;
  store_unavailable: boolean;
  user_history: boolean;
  device_history: boolean;
  bank_context_used: boolean;
}

export interface SentinelScoreOut {
  event_id: string;
  model: string | null;
  raw_score: number | null;
  risk_score: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  scored: boolean;
  contributions: Contributions;
  model_version: string;
  degraded?: boolean;
  degradation?: Degradation;
  explanation?: Explanation | null;
}

const bool01 = (v: boolean | undefined): number | undefined =>
  v === undefined ? undefined : v ? 1 : 0;

/** Asia/Kolkata. India-only bank, and IST has no DST, so a constant is exact. */
const BANK_UTC_OFFSET_MINUTES = 330;

/**
 * Same instant, expressed in the bank's local offset instead of `Z`.
 *
 * The model derives `f_hour` / `f_is_night` from the offset it is handed
 * (service/feature_service.py -> ml.feature_core.stateless_features), and it was
 * trained on wall-clock local time. Sending `toISOString()` therefore reported
 * every Indian business morning as pre-dawn activity: 09:00 IST arrives as 03:30,
 * lands in the model's night window, and adds "unusual time of day" to routine
 * payments. Measured on a routine transfer at 07:42 IST: 0.485 (CRITICAL) sent as
 * UTC vs 0.004 (LOW) sent as +05:30 — the single largest distortion on the path.
 * The instant is unchanged, so the service's future-skew check is unaffected.
 */
export function toBankLocalIso(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const shifted = new Date(t.getTime() + BANK_UTC_OFFSET_MINUTES * 60_000);
  return `${shifted.toISOString().slice(0, -1)}+05:30`;
}

/** Drop keys whose value is undefined so `extra="forbid"` never trips. */
function compact<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}

/** Build the model request body from a bank UnifiedEvent. */
export function toEventIn(e: UnifiedEvent): SentinelEventIn {
  const domain: Domain = e.eventType === 'LOGIN' ? 'behaviour' : 'financial';
  const ageSeconds =
    e.beneficiaryAgeMinutes != null ? e.beneficiaryAgeMinutes * 60 : undefined;
  const isPayment =
    e.eventType === 'PAYMENT_INITIATE' || e.eventType === 'PAYMENT_MODIFY';

  return compact<SentinelEventIn>({
    // Never send a stale/hardcoded time — the model rejects future skew. Fall
    // back to now() so a missing timestamp can't fail the request.
    event_id: e.eventId ?? `evt:${Date.now()}`,
    event_domain: domain,
    event_time: toBankLocalIso(e.timestamp ?? new Date().toISOString()),
    user_id: e.userId,
    device_id: e.deviceFingerprint,
    event_type: e.eventType,
    country: e.country,
    // Home market is India; anything else is a foreign request (weak on its own,
    // but pairs with the model's new-country history signal).
    is_foreign_request: e.country ? (e.country !== 'IN' ? 1 : 0) : undefined,
    geo_lat: e.geoLat,
    geo_lon: e.geoLon,
    amount: e.amount,
    currency: isPayment ? 'INR' : undefined,
    payment_type: isPayment ? 'transfer' : undefined,
    is_credit: isPayment ? 0 : undefined,
    // Keys the store's per-user payee set — the only way the model can tell a
    // monthly supplier apart from a payee it has never seen.
    counterparty_id: e.beneficiaryId,
    counterparty_is_new: bool01(e.isNewBeneficiary),
    counterparty_age_s: ageSeconds,
    name_mismatch: bool01(e.nameMismatch),
    balance_before: e.balanceBefore,
    balance_after: e.balanceAfter,
    counterparty_balance_before: e.counterpartyBalanceBefore,
    counterparty_balance_after: e.counterpartyBalanceAfter,
    customer_age: e.customerAge,
    account_age_s: e.accountAgeSeconds,
    income: e.income,
    email_is_free: bool01(e.emailIsFree),
    channel: e.channel,
    device_os: e.deviceOs,
    bank_txn_count_1h: e.txnCountLastHour,
    bank_amount_vs_user_mean: e.amountVsUserMean,
    bank_beneficiary_age_s: ageSeconds,
    bank_is_new_beneficiary: bool01(e.isNewBeneficiary),
  });
}

const LEVEL: Record<SentinelScoreOut['risk_level'], RiskLevel> = {
  low: RiskLevel.LOW,
  medium: RiskLevel.MEDIUM,
  high: RiskLevel.HIGH,
  critical: RiskLevel.CRITICAL,
};

/**
 * Human-readable text for raw model feature names. When the model returns no
 * plain-language reasons we fall back to its top SHAP features — but the raw
 * names (`f_user_seq_no`, `duration_s`, …) must never reach the UI. Anything not
 * mapped here is dropped rather than shown as a technical token.
 */
const FEATURE_LABELS: Record<string, string> = {
  duration_s: 'unusual session duration',
  f_user_secs_since_last: 'unusual time since previous activity',
  f_user_seq_no: 'customer has little prior history',
  f_device_seq_no: 'unusual device history',
  f_user_new_country: 'unusual new country for this customer',
  f_dayofweek: 'unusual day of week',
  f_is_weekend: 'unusual day of week',
  f_hour: 'unusual time of day',
  f_hour_cos: 'unusual time of day',
  f_hour_sin: 'unusual time of day',
  f_is_night: 'unusual time of day',
  amount: 'unusual transaction amount',
  f_log1p_amount: 'unusual transaction amount',
  f_amount_ratio_mean: 'amount differs from the customer average',
  f_amount_z_user: 'amount differs from the customer average',
  bank_amount_vs_user_mean: 'amount differs from the customer average',
  bank_txn_count_1h: 'elevated transaction velocity',
  f_user_txn_count_1h: 'elevated transaction velocity',
  f_user_distinct_counterparties: 'unusual number of known payees',
  name_mismatch: 'beneficiary name does not match the account holder',
  merchant_category: 'unusual merchant category',
  f_bytes_ratio: 'unusual traffic volume',
  f_log1p_bytes_out: 'unusual outbound data volume',
  dst_port: 'connection to an unusual port',
};

/** Reasons we never surface (demo-noisy / exposes internal timing). */
const REASON_BLOCKLIST = [/beneficiary was added .*ago/i, /beneficiary activated .*ago/i];

/**
 * Build clean, human-readable reasons: prefer the model's plain-language reasons,
 * else map its top features to friendly text (dropping unmapped raw names), then
 * strip blocklisted reasons and de-duplicate.
 */
export function humanizeReasons(
  reasons: string[] | undefined,
  topFeatures?: { feature: string }[],
): string[] {
  const source =
    reasons && reasons.length > 0
      ? reasons
      : (topFeatures ?? []).map((f) => FEATURE_LABELS[f.feature]).filter((x): x is string => !!x);
  const cleaned = source.filter((r) => r && !REASON_BLOCKLIST.some((re) => re.test(r)));
  return [...new Set(cleaned)];
}

/** Map the model's ScoreOut back to the bank's RiskVerdict. */
export function toRiskVerdict(out: SentinelScoreOut): RiskVerdict {
  const c = out.contributions ?? {};
  const modelScores: Record<string, number> = {};
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'number') modelScores[k] = v;
  }

  const reasons = humanizeReasons(out.explanation?.reasons, out.explanation?.top_features);

  return {
    riskScore: out.risk_score,
    riskLevel: LEVEL[out.risk_level],
    reasons: reasons.length > 0 ? reasons : ['No specific anomalies highlighted'],
    modelScores,
  };
}
