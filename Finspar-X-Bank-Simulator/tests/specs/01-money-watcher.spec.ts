import { test, expect, BACKEND, CREDS } from '../helpers/fixtures';
import { label, loginViaUi, gotoSettled, seedSession } from '../helpers/ui';
import { beneCode, custRef } from '../helpers/ids';
import { auth, held } from '../helpers/api';
import { expectModelCalls } from '../helpers/backend-log';
import { assertModelVerdict } from '../helpers/model-guard';

/**
 * Watcher 1 — the Money Watcher (`fraud_payment`, XGBoost). The headline demo.
 *
 * MEASURED BEHAVIOUR — this differs from DEMO_PRESENTATION.md §6, which presents
 * both beats as a single flow:
 *
 *   brand-new payee, first ever payment   -> CRITICAL -> BLOCKED (account frozen)
 *   established payee, off-pattern amount -> HIGH     -> HELD    (analyst queue)
 *
 * The doc's script says the drain lands on HELD and is then released by an
 * authorizer. It does not. With a payee added minutes ago the model returned
 * critical at every amount swept through the real bank flow (25k, 50k, 100k,
 * 150k, 250k), and the decision engine maps CRITICAL to BLOCK, not HOLD.
 * Notably the doc's exact demo amount, ₹2,50,000, scores 0.2429906576871872
 * against a fitted critical edge of 0.242990642786026 — over by 1.5e-8, i.e.
 * sitting precisely on the boundary.
 *
 * So the beats are tested as what they really are: the drain is the "no money
 * moved" beat, and the governance beat needs an established payee.
 */
test.describe.configure({ mode: 'serial' });

test('@demo the drain: a first-ever payment to a brand-new payee is BLOCKED before any money moves', async ({
  page,
  backend,
  maker,
}) => {
  const CODE = beneCode();
  const NAME = 'Quick Cash Traders';
  const REF = custRef('DRAIN');

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

  // ---- Activate it — this is what starts the cooling clock --------------
  // Mandatory: FraudGateway derives beneficiaryAgeMinutes from `activatedAt`,
  // so skipping activation silently removes the new-payee signal altogether.
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
  // lines rather than the model's per-worker /metrics counter.
  const { result } = await expectModelCalls(
    1,
    async () => {
      const waiting = page.waitForResponse(
        (r) => /\/api\/payments\/[^/]+\/confirm$/.test(r.url()) && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Confirm' }).click();
      return (await waiting).json();
    },
    'drain payment confirm',
  );

  expect(result.outcome).toBe('BLOCKED');
  expect(result.riskLevel).toBe('CRITICAL'); // Prisma enum -> UPPERCASE
  assertModelVerdict(result, 'drain payment');
  // The model's own words are the demo's best line.
  expect(result.reasons.join(' | ')).toMatch(/beneficiary|payment|amount|history/i);

  await expect(page.getByText('Payment blocked — account frozen for review')).toBeVisible();

  // ---- No money moved, and a case was raised ----------------------------
  const cases = await (
    await backend.get(`${BACKEND}/api/analyst/cases`, { headers: auth(maker.token) })
  ).json();
  expect(cases.some((c: any) => c.source === 'AI_FLAGGED')).toBeTruthy();
});

test('@demo governance: an off-pattern payment to an established payee is HELD, and only an AUTHORIZER can release it', async ({
  page,
  browser,
  backend,
  maker,
  authorizer,
}) => {
  const REF = custRef('GOV');

  // A payee activated days ago (seeded). A brand-new one scores CRITICAL and is
  // blocked outright, so it never reaches the analyst queue this beat is about.
  const benes = await (
    await backend.get(`${BACKEND}/api/beneficiaries`, { headers: auth(maker.token) })
  ).json();
  const established = benes.find(
    (b: any) =>
      b.status === 'ACTIVE' &&
      b.allowIMPS &&
      b.activatedAt &&
      Date.now() - new Date(b.activatedAt).getTime() > 24 * 3600_000,
  );
  test.skip(!established, 'no established IMPS payee — run npm run db:seed');

  await loginViaUi(page, CREDS.maker.userId, CREDS.maker.password, '');
  await gotoSettled(page, '/payments/initiate');
  await page.getByRole('button', { name: /IMPS/ }).click();
  await label(page, 'Cust Ref #').fill(REF);
  await label(page, 'Amount (INR)').fill('25000');

  const debit = label(page, 'Debit Account');
  await debit.selectOption((await debit.locator('option').nth(1).getAttribute('value'))!);
  const bene = label(page, 'Beneficiary');
  await bene.selectOption(
    (await bene.locator('option', { hasText: established.code }).getAttribute('value'))!,
  );
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  const { result: first } = await expectModelCalls(
    1,
    async () => {
      const waiting = page.waitForResponse(
        (r) => /\/api\/payments\/[^/]+\/confirm$/.test(r.url()) && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Confirm' }).click();
      return (await waiting).json();
    },
    'governance payment confirm',
  );

  expect(first.outcome).toBe('HELD');
  expect(first.riskLevel).toBe('HIGH');
  assertModelVerdict(first, 'governance payment');

  // The UI never prints the literal "HELD". A fraud hold reads exactly
  // "Funds held for analyst review"; a cut-off/limit hold reads "Funds held — …".
  // Asserting both directions stops a cut-off masquerading as a fraud hold.
  await expect(page.getByText('Funds held for analyst review')).toBeVisible();
  await expect(page.getByText(/Funds held —/)).toHaveCount(0);

  // ---- It is in the authorizer's queue ----------------------------------
  const queue = await held(backend, maker.token);
  const mine = queue.find((h: any) => String(h.amount) === '2500000');
  expect(mine, 'payment did not appear in GET /api/analyst/held').toBeTruthy();
  const { refNo, paymentId } = mine;
  expect(mine.riskLevel).toBe('HIGH');

  // ---- Separation of duties: the maker cannot release his own payment ---
  const forbidden = await backend.post(`${BACKEND}/api/analyst/payments/${paymentId}/release`, {
    headers: auth(maker.token),
  });
  expect(forbidden.status(), 'MAKER must get 403').toBe(403);
  expect((await forbidden.json()).message).toContain('Only an authorizer');

  // ---- The authorizer reviews and releases ------------------------------
  const aCtx = await browser.newContext();
  await seedSession(aCtx, authorizer);
  const aPage = await aCtx.newPage();
  await aPage.goto('/analyst');
  // The held-payment card is the only element carrying the risk-high border.
  // A bare div.filter(hasText) would resolve to some inner wrapper that does not
  // contain the action buttons. No networkidle here — /analyst polls forever.
  const card = aPage.locator('[class*="border-risk-high"]').filter({ hasText: refNo });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Release' }).click();
  await expect(aPage.getByText(/Payment approved/)).toBeVisible();

  // ---- Authorize & Send, and prove it is NOT re-scored ------------------
  // There is no /payments/authorize route: it is /payments/modify, the table
  // stays empty until Search is clicked, and the action button is icon-only.
  await gotoSettled(aPage, '/payments/modify');
  await label(aPage, 'Reference Number').fill(refNo);
  await aPage.getByRole('button', { name: 'Search' }).click();
  await expect(aPage.getByText(refNo).first()).toBeVisible();

  // Opening the send modal fires POST /confirm immediately. `reviewApproved`
  // short-circuits BEFORE the fraud gateway, so this must reach the model ZERO
  // times — the assertion the per-worker metrics counter could not support.
  const { result: second } = await expectModelCalls(
    0,
    async () => {
      const waiting = aPage.waitForResponse(
        (r) => /\/api\/payments\/[^/]+\/confirm$/.test(r.url()) && r.request().method() === 'POST',
      );
      await aPage.getByTitle('Authorize & Send').click();
      return (await waiting).json();
    },
    're-authorise after release must not re-score',
  );
  expect(second.outcome, 'a released payment must not be re-held').toBe('OTP');

  await label(aPage, 'Transaction Password').fill(CREDS.txnPassword);
  await label(aPage, 'OTP').fill(CREDS.otp);
  const waitingSubmit = aPage.waitForResponse(
    (r) => /\/api\/payments\/[^/]+\/submit$/.test(r.url()) && r.request().method() === 'POST',
  );
  await aPage.getByRole('button', { name: 'Submit' }).click();
  const submitted = await (await waitingSubmit).json();

  expect(
    submitted.outcome,
    submitted.outcome === 'HELD_CUTOFF'
      ? `HELD_CUTOFF (${submitted.reason}) — the cut-off/limit rule masked the result; IMPS should be exempt, check the rail`
      : 'expected COMPLETED',
  ).toBe('COMPLETED');

  // No longer on hold anywhere.
  expect((await held(backend, authorizer.token)).map((h: any) => h.refNo)).not.toContain(refNo);
  await aCtx.close();
});

test('a VIEWER also cannot release a held payment', async ({ backend, maker }) => {
  // Confirms the guard is `role === 'AUTHORIZER'`, not merely `!== 'MAKER'`.
  const { apiLogin } = await import('../helpers/api');
  const viewer = await apiLogin(backend, CREDS.viewerId, CREDS.viewerPassword, 'IN');
  const queue = await held(backend, maker.token);
  test.skip(queue.length === 0, 'no held payment available to attempt a release on');

  const res = await backend.post(`${BACKEND}/api/analyst/payments/${queue[0].paymentId}/release`, {
    headers: auth(viewer.token),
  });
  expect(res.status()).toBe(403);
});
