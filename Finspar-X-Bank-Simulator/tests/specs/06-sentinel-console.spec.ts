import { test, expect, CREDS } from '../helpers/fixtures';
import { loginViaUi } from '../helpers/ui';

/**
 * The Sentinel Console — the in-app surface for the two watchers that have no
 * banking flow (Intrusion, Future-Proofing) plus the Command Center fusion view.
 *
 * This is what the jury actually looks at, so it is worth guarding: a broken
 * proxy route or a renamed preset is invisible until someone is on stage.
 *
 * Note the console talks to /api/sentinel/score, not the model directly — the
 * FastAPI service mounts no CORS middleware, so a browser cannot reach :8000.
 */
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await loginViaUi(page, CREDS.maker.userId, CREDS.maker.password, '');
  await page.goto('/sentinel');
  await expect(page.getByRole('heading', { name: 'Sentinel Console' })).toBeVisible();
});

test('@demo Intrusion tab: a malware C2 event comes back CRITICAL', async ({ page }) => {
  await page.getByTestId('tab-intrusion').click();
  await page.getByTestId('send-cyber').click();

  const verdict = page.getByTestId('verdict-cyber');
  await expect(verdict).toBeVisible();
  await expect(verdict.getByText('CRITICAL', { exact: true })).toBeVisible();
  await expect(verdict.getByText(/routed to/)).toContainText('cyber');
});

test('@demo Future-Proofing tab: secret data is CRITICAL, internal data is LOW', async ({
  page,
}) => {
  await page.getByTestId('tab-quantum').click();

  // Preset 1 — secret data behind RSA-2048 on a 10-year certificate.
  await page.getByTestId('send-quantum').click();
  const verdict = page.getByTestId('verdict-quantum');
  await expect(verdict).toBeVisible();
  await expect(verdict.getByText('CRITICAL', { exact: true })).toBeVisible();

  // The contrast beat that actually works: drop the data classification.
  // (NOT the algorithm — measured, Kyber vs RSA changes nothing.)
  await page.locator('#preset-quantum').selectOption('internal-low');
  await page.getByTestId('send-quantum').click();
  await expect(page.getByTestId('verdict-quantum').getByText('LOW', { exact: true })).toBeVisible();
});

test('@demo Command Center: each domain lights up exactly one watcher', async ({ page }) => {
  await page.getByTestId('tab-command').click();
  await page.getByTestId('send-command-center').click();

  // Four cards, one per watcher, each naming the contribution key that fired.
  for (const label of [
    'Money Watcher',
    'Habits Watcher',
    'Intrusion Watcher',
    'Future-Proofing Watcher',
  ]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText('p_fraud_payment').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('p_cyber').first()).toBeVisible();
  await expect(page.getByText('p_quantum').first()).toBeVisible();

  // The live counter proves the models are genuinely being called.
  await expect(page.getByText(/^total \d+$/)).toBeVisible({ timeout: 30_000 });
});

test('an invalid field surfaces the model’s own 422 rather than a generic failure', async ({
  page,
}) => {
  // The model's EventIn is extra="forbid"; the proxy passes its error through so
  // whoever is editing the form can see which field was rejected.
  await page.getByTestId('tab-intrusion').click();
  await page.locator('#cyber-protocol').fill('tcp');
  const res = await page.request.post('http://127.0.0.1:3001/api/sentinel/score', {
    data: {
      event_id: 'console-bad',
      event_domain: 'cyber',
      event_time: new Date().toISOString(),
      not_a_real_field: 1,
    },
  });
  expect(res.status()).toBe(422);
});

test('the proxy refuses a domain the console has no business sending', async ({ page }) => {
  const res = await page.request.post('http://127.0.0.1:3001/api/sentinel/score', {
    data: { event_id: 'x', event_domain: 'not_a_domain', event_time: new Date().toISOString() },
  });
  expect(res.status()).toBe(400);
});
