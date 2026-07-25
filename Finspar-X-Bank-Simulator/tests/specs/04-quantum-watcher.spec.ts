import { test, expect } from '@playwright/test';
import { score } from '../helpers/sentinel';
import { uniqueSuffix } from '../helpers/ids';

/**
 * Watcher 4 — the Future-Proofing Watcher (`quantum`, XGBoost).
 *
 * Like `cyber`, this head has no banking surface; the Sentinel Console's
 * Future-Proofing tab drives the same endpoint.
 */
test.describe.configure({ retries: 2 });

const base = (over: Record<string, unknown>) => ({
  event_id: `e2e-quantum:${uniqueSuffix()}`,
  event_domain: 'quantum',
  user_id: `tls-${uniqueSuffix()}`,
  q_key_exchange: 'RSA-2048',
  q_cert_key_type: 'RSA',
  q_data_class: 'secret',
  q_cert_age_days: 30,
  q_cert_validity_days: 3650,
  ...over,
});

test('@demo secret data behind RSA-2048 on a 10-year certificate scores critical', async ({
  request,
}) => {
  const out = await score(request, base({}));

  expect(out.scored).toBe(true);
  expect(out.model).toBe('quantum');
  expect(out.risk_level).toBe('critical');
  expect(out.contributions.p_quantum).toBeGreaterThan(0);
  for (const k of ['p_fraud_payment', 'p_behaviour', 'p_cyber'] as const) {
    expect(out.contributions[k] ?? null).toBeNull();
  }
});

/**
 * The contrast beat that actually works.
 *
 * DEMO_PRESENTATION.md §9.4 says to flip the ALGORITHM
 * (`q_cert_key_type: "Kyber", q_cert_validity_days: 90`) to get `low`. Measured,
 * that changes nothing at all. What moves the verdict is the data
 * classification — see the matrix test below.
 */
test('@demo contrast: the same weak certificate on internal data scores low', async ({
  request,
}) => {
  const out = await score(request, base({ q_data_class: 'internal' }));
  expect(out.risk_level).toBe('low');
  expect(out.model).toBe('quantum');
});

/**
 * Pins the model's REAL behaviour: `q_data_class` is the only lever.
 *
 * Measured across the full matrix — algorithm and certificate lifetime have zero
 * effect, and risk_score is binary (0.0 or 0.9):
 *
 *   RSA-2048 / internal / 90d   -> low        Kyber / internal / 90d   -> low
 *   RSA-2048 / internal / 3650d -> low        Kyber / internal / 3650d -> low
 *   RSA-2048 / secret   / 90d   -> critical   Kyber / secret   / 90d   -> critical
 *   RSA-2048 / secret   / 3650d -> critical   Kyber / secret   / 3650d -> critical
 *
 * This contradicts the demo narrative ("sensitivity x algorithm weakness x
 * certificate lifetime") and means rotating to post-quantum crypto does NOT
 * lower the score. Asserted deliberately so that a retrain which fixes it FAILS
 * this test and tells you the story can be told properly again.
 */
test('documents: only q_data_class moves the verdict — not the algorithm or cert lifetime', async ({
  request,
}) => {
  const rsaLong = await score(request, base({ q_cert_key_type: 'RSA', q_cert_validity_days: 3650 }));
  const pqShort = await score(
    request,
    base({ q_key_exchange: 'Kyber', q_cert_key_type: 'Kyber', q_cert_validity_days: 90 }),
  );

  expect(
    pqShort.risk_level,
    'If this now differs from RSA, the quantum head has been retrained to weigh the ' +
      'algorithm — update this test and re-enable the doc\'s original contrast beat.',
  ).toBe(rsaLong.risk_level);

  // And the lever that does work:
  const internal = await score(request, base({ q_data_class: 'internal' }));
  expect(internal.risk_score).toBeLessThan(rsaLong.risk_score);
});

test('a public-facing service with the same certificate scores low', async ({ request }) => {
  const out = await score(request, base({ q_data_class: 'public' }));
  expect(out.risk_level).toBe('low');
});
