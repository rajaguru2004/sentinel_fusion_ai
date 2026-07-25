import { test, expect, CREDS } from '../helpers/fixtures';
import { label, loginViaUi, gotoSettled } from '../helpers/ui';
import { beneCode, custRef } from '../helpers/ids';
import { expectModelCalls } from '../helpers/backend-log';
import { assertModelVerdict } from '../helpers/model-guard';

/**
 * Watcher 1 — the Money Watcher (`fraud_payment`, XGBoost). The demo panel runs
 * exactly this: LOGIN -> add a brand-new payee -> make a payment, and prove the
 * LIVE model scores it before any money moves.
 *
 * The exact fraud band for a brand-new payee shifts with feature-store state
 * (BLOCKED / HELD / CHALLENGE / OTP all mean "the model saw and judged it" — the
 * ₹2,50,000 case sits on the CRITICAL boundary by ~1.5e-8). So this asserts the
 * payment was genuinely SCORED BY THE MODEL, not one specific band — which is
 * what makes it a reliable, repeatable stage demo.
 */
test('@demo the money path: login -> new payee -> payment is scored by the live model', async ({
  page,
}) => {
  const CODE = beneCode();
  const NAME = 'Quick Cash Traders';
  const REF = custRef('DEMO');

  await loginViaUi(page, CREDS.maker.userId, CREDS.maker.password, '');

  // ---- Add the payee the fraudster controls -----------------------------
  await gotoSettled(page, '/beneficiary/maintenance');
  await page.getByRole('button', { name: 'Add New' }).click();
  await label(page, 'Beneficiary Code').fill(CODE);
  await label(page, 'Beneficiary Name').fill(NAME);
  // The rail radio must come first — the Bank Details card is conditional on it.
  await page.locator('label').filter({ hasText: /^IMPS$/ }).locator('input[type=radio]').check();
  await label(page, 'Account Number').fill('50100234567890');
  await label(page, 'Confirm Account Number').fill('50100234567890');
  await label(page, 'IFSC Code').fill('HDFC0001234'); // ^[A-Z]{4}0[A-Z0-9]{6}$
  // exact: the Next.js dev-tools overlay button is also named "Next…".
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm & Add' }).click();
  await expect(page.getByText('Beneficiary added — pending activation')).toBeVisible();

  // ---- Activate it — this starts the cooling clock the model reads -------
  await gotoSettled(page, '/beneficiary/activate');
  const row = page.getByRole('row', { name: new RegExp(CODE) });
  await expect(row).toBeVisible();
  await row.locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByText(/Activated 1/)).toBeVisible();

  // ---- Push the money ----------------------------------------------------
  await gotoSettled(page, '/payments/initiate');
  // Mode gate renders before the form; the IMPS card's accessible name is
  // "IMPS IMPS" (label + rail badge), so an exact match would miss it.
  await page.getByRole('button', { name: /IMPS/ }).click();
  await label(page, 'Cust Ref #').fill(REF);
  await label(page, 'Amount (INR)').fill('250000');

  const debit = label(page, 'Debit Account');
  await debit.selectOption((await debit.locator('option').nth(1).getAttribute('value'))!);
  const bene = label(page, 'Beneficiary');
  await bene.selectOption((await bene.locator('option', { hasText: CODE }).getAttribute('value'))!);
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Exactly one model call, counted from the backend's own "[Sentinel /score]"
  // lines — proves the payment reached the live ML model, not the heuristic.
  const { result } = await expectModelCalls(
    1,
    async () => {
      const waiting = page.waitForResponse(
        (r) => /\/api\/payments\/[^/]+\/confirm$/.test(r.url()) && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Confirm' }).click();
      return (await waiting).json();
    },
    'money-path payment confirm',
  );

  // The Money Watcher scored this login -> payment. Any real fraud-gateway
  // verdict proves the flow end to end; the exact band varies with state.
  expect(['BLOCKED', 'HELD', 'CHALLENGE', 'OTP']).toContain(result.outcome);
  assertModelVerdict(result, 'money-path payment');
  // The model's own plain-language reasons are the demo's best line.
  expect(result.reasons.join(' | ')).toMatch(/beneficiary|payment|amount|history|anomal|new/i);
});
