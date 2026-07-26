/**
 * Display-time cleanup for risk reasons.
 *
 * Reasons persisted before the backend adapter fix (and any that still slip
 * through) can contain raw model feature names (`f_user_seq_no`, `duration_s`)
 * or the internal beneficiary-age line. This maps raw names to friendly text,
 * drops unmapped technical tokens, strips the blocklisted lines, and dedupes —
 * so the analyst feed and payment screens always read in plain English.
 * Mirrors humanizeReasons in apps/backend/src/fraud/sentinel-adapter.ts.
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
  event_subtype: '',
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

const BLOCKLIST = [/beneficiary was added .*ago/i, /beneficiary activated .*ago/i];

/** Looks like a raw model feature token (e.g. `f_user_seq_no`, `duration_s`). */
function isRawToken(s: string): boolean {
  if (typeof s !== 'string') return false;
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(s.trim());
}

export function humanizeReasons(reasons: any[] | undefined | null): string[] {
  if (!reasons || !Array.isArray(reasons)) return [];
  const out: string[] = [];
  for (const item of reasons) {
    if (!item) continue;
    let raw = '';
    if (typeof item === 'string') {
      raw = item;
    } else if (typeof item === 'object') {
      raw = item.label || item.reason || item.code || item.feature || JSON.stringify(item);
    } else {
      raw = String(item);
    }
    if (typeof raw !== 'string' || !raw.trim()) continue;

    if (BLOCKLIST.some((re) => re.test(raw))) continue; // drop beneficiary-age line
    if (raw in FEATURE_LABELS) {
      const mapped = FEATURE_LABELS[raw];
      if (mapped) out.push(mapped);
      continue;
    }
    if (isRawToken(raw)) continue; // unknown technical token -> hide, don't show raw
    out.push(raw); // already human-readable
  }
  return [...new Set(out)];
}

/**
 * Human label for a raw model feature name, for the SHAP breakdown.
 */
export function featureLabel(feature: any): string {
  if (!feature) return '';
  const str = typeof feature === 'string' ? feature : String(feature);
  const mapped = FEATURE_LABELS[str];
  if (mapped) return mapped;
  return str
    .replace(/^(f_|q_|bank_)/, '')
    .replace(/_/g, ' ')
    .trim();
}

