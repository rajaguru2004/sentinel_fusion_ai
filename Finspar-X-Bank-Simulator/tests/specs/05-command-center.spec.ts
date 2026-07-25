import { test, expect } from '@playwright/test';
import { score, type ScoreOut } from '../helpers/sentinel';
import { uniqueSuffix } from '../helpers/ids';
import { SENTINEL } from '../helpers/env';

/**
 * The Command Center — weighted noisy-OR fusion + isotonic calibration.
 *
 * The externally checkable properties are ROUTING (exactly one head fires per
 * domain), the response envelope, and the calibration ordering. The fusion maths
 * itself is not observable from here, so we assert what is.
 */
test.describe.configure({ retries: 2 });

const EVENTS: {
  key: string;
  expected: keyof ScoreOut['contributions'];
  model: string;
  build: () => Record<string, unknown>;
}[] = [
  {
    key: 'financial',
    expected: 'p_fraud_payment',
    model: 'fraud_payment',
    build: () => ({
      event_id: `cc-fin:${uniqueSuffix()}`,
      event_domain: 'financial',
      user_id: `cc-cust-${uniqueSuffix()}`,
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
    expected: 'p_behaviour',
    model: 'behaviour',
    build: () => ({
      event_id: `cc-beh:${uniqueSuffix()}`,
      event_domain: 'behaviour',
      user_id: `cc-user-${uniqueSuffix()}`,
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
    expected: 'p_cyber',
    model: 'cyber',
    build: () => ({
      event_id: `cc-cyb:${uniqueSuffix()}`,
      event_domain: 'cyber',
      user_id: `cc-host-${uniqueSuffix()}`,
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
    key: 'quantum',
    expected: 'p_quantum',
    model: 'quantum',
    build: () => ({
      event_id: `cc-qua:${uniqueSuffix()}`,
      event_domain: 'quantum',
      user_id: `cc-tls-${uniqueSuffix()}`,
      q_key_exchange: 'RSA-2048',
      q_cert_key_type: 'RSA',
      q_data_class: 'secret',
      q_cert_age_days: 30,
      q_cert_validity_days: 3650,
    }),
  },
];

const ALL_KEYS = [
  'p_fraud_payment',
  'p_fraud_application',
  'p_cyber',
  'p_behaviour',
  'p_quantum',
] as const;

for (const ev of EVENTS) {
  test(`@demo routing: a ${ev.key} event lights up exactly one watcher`, async ({ request }) => {
    const out = await score(request, ev.build());

    expect(out.scored).toBe(true);
    expect(out.model).toBe(ev.model);
    expect(out.contributions[ev.expected], `${ev.expected} should have fired`).not.toBeNull();
    expect(typeof out.contributions[ev.expected]).toBe('number');

    // Every other head stays silent. `p_fraud` is excluded — it is a deprecated
    // mirror of whichever fraud head scored, not a fifth watcher.
    for (const k of ALL_KEYS) {
      if (k === ev.expected) continue;
      expect(out.contributions[k] ?? null, `${k} should NOT have fired for ${ev.key}`).toBeNull();
    }
  });
}

test('the deprecated p_fraud mirror still matches p_fraud_payment', async ({ request }) => {
  // schemas.py keeps p_fraud so an existing bank client keeps working without a
  // coordinated release. This is the compatibility contract that will silently
  // break the day it is removed.
  const out = await score(request, EVENTS[0].build());
  expect(out.contributions.p_fraud).toBe(out.contributions.p_fraud_payment);
});

test('envelope invariants hold for every domain', async ({ request }) => {
  for (const ev of EVENTS) {
    const out = await score(request, ev.build());
    expect(out.risk_score, `${ev.key} risk_score range`).toBeGreaterThanOrEqual(0);
    expect(out.risk_score, `${ev.key} risk_score range`).toBeLessThanOrEqual(1);
    expect(['low', 'medium', 'high', 'critical']).toContain(out.risk_level);
    expect(out.model_version).toBeTruthy();
    expect(out.degradation).toBeTruthy();
    for (const flag of [
      'degraded',
      'store_unavailable',
      'user_history',
      'device_history',
      'bank_context_used',
    ] as const) {
      expect(typeof out.degradation![flag]).toBe('boolean');
    }
  }
});

test('model_version matches what /ready advertises', async ({ request }) => {
  const ready = await (await request.get(`${SENTINEL}/ready`)).json();
  const out = await score(request, EVENTS[0].build());
  expect(out.model_version).toBe(ready.model_version);
});

test('calibration is monotone: a higher band never has a lower score', async ({ request }) => {
  // The only externally checkable property of the isotonic step.
  const rank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  const weak = await score(request, {
    event_id: `cc-mono-low:${uniqueSuffix()}`,
    event_domain: 'quantum',
    user_id: `cc-tls-${uniqueSuffix()}`,
    q_key_exchange: 'RSA-2048',
    q_cert_key_type: 'RSA',
    q_data_class: 'internal',
    q_cert_age_days: 30,
    q_cert_validity_days: 3650,
  });
  const strong = await score(request, EVENTS[3].build());

  expect(rank[strong.risk_level]).toBeGreaterThan(rank[weak.risk_level]);
  expect(strong.risk_score).toBeGreaterThan(weak.risk_score);
});

test('an out-of-scope domain returns scored:false with no contributions', async ({ request }) => {
  const out = await score(request, {
    event_id: `cc-ti:${uniqueSuffix()}`,
    event_domain: 'threat_intel',
    user_id: `cc-ti-${uniqueSuffix()}`,
  });
  expect(out.scored).toBe(false);
  expect(out.model).toBeNull();
  for (const k of ALL_KEYS) expect(out.contributions[k] ?? null).toBeNull();
  // NOTE: HttpScorer treats scored:false as a reason to fall back to the
  // heuristic ("Sentinel returned scored=false ... using heuristic"), which is
  // exactly what the noFailOpen fixture greps for in the UI specs.
});

test('a cold-start financial event returns plain-language reasons', async ({ request }) => {
  // Cold start is where reasons are reliably populated: an established entity
  // with unremarkable features often returns an empty list.
  const out = await score(request, EVENTS[0].build());
  expect(out.explanation).toBeTruthy();
  expect(out.explanation!.reasons.length).toBeGreaterThan(0);
  expect(out.explanation!.model).toBe('fraud_payment');
});

test('explain=false omits the explanation entirely', async ({ request }) => {
  const out = await score(request, EVENTS[0].build(), { explain: false });
  expect(out.explanation ?? null).toBeNull();
});
