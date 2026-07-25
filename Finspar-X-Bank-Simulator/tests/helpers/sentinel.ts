import { expect, type APIRequestContext } from '@playwright/test';
import { SENTINEL, SENTINEL_KEY } from './env';

export interface ScoreOut {
  event_id: string;
  model: string | null;
  raw_score: number | null;
  risk_score: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  scored: boolean;
  contributions: {
    p_fraud?: number | null;
    p_fraud_payment?: number | null;
    p_fraud_application?: number | null;
    p_cyber?: number | null;
    p_behaviour?: number | null;
    p_quantum?: number | null;
  };
  model_version: string;
  degraded?: boolean;
  degradation?: {
    degraded: boolean;
    store_unavailable: boolean;
    user_history: boolean;
    device_history: boolean;
    bank_context_used: boolean;
  };
  explanation?: {
    model: string;
    top_features: { feature: string; value: number | null; shap: number }[];
    reasons: string[];
  } | null;
}

/**
 * POST /score. Supplies the API key and a tz-aware `event_time` (…Z).
 *
 * The model's EventIn is `extra="forbid"`, so one stray key is a 422; and
 * `event_time` must be timezone-aware and no more than
 * reject_future_events_seconds (300) ahead.
 */
export async function score(
  request: APIRequestContext,
  event: Record<string, unknown>,
  opts: { explain?: boolean } = {},
): Promise<ScoreOut> {
  const explain = opts.explain ?? true;
  const res = await request.post(`${SENTINEL}/score?explain=${explain}`, {
    headers: { 'X-API-Key': SENTINEL_KEY, 'Content-Type': 'application/json' },
    data: { event_time: new Date().toISOString(), ...event },
    timeout: 45_000,
  });
  expect(res.ok(), `POST /score -> ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

/** Same call, but returns the raw status — for the 422 contract tests. */
export async function scoreRaw(
  request: APIRequestContext,
  event: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const res = await request.post(`${SENTINEL}/score?explain=false`, {
    headers: { 'X-API-Key': SENTINEL_KEY, 'Content-Type': 'application/json' },
    data: event,
    timeout: 45_000,
  });
  return { status: res.status(), body: await res.text() };
}

/**
 * Sum of `sentinel_scored_total` across every label combination.
 *
 * CAUTION — this is a POSITIVE-ONLY signal. The service runs
 * `uvicorn --workers 2` and prometheus_client counters are per-process and
 * in-memory, so consecutive scrapes land on different workers and disagree:
 * measured on an idle service, /metrics alternated between 7 counter rows and 0.
 *
 * A rise proves the model was called. A flat reading proves NOTHING — you may
 * simply have scraped the other worker. For an exact count of what the BANK
 * scored, use helpers/backend-log.ts, which reads the single Nest process's
 * "[Sentinel /score]" lines.
 */
export async function scoredTotal(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${SENTINEL}/metrics`, { timeout: 10_000 });
  const body = await res.text();
  return body
    .split('\n')
    .filter((l) => l.startsWith('sentinel_scored_total{'))
    .reduce((acc, l) => acc + (Number(l.slice(l.lastIndexOf(' ') + 1)) || 0), 0);
}
