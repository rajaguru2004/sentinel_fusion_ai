import { test, expect, CREDS } from '../helpers/fixtures';
import { label, loginViaUi, logoutViaUi } from '../helpers/ui';
import { feed } from '../helpers/api';
import { assertModelVerdict } from '../helpers/model-guard';
import { expectModelCalls, logSince, logOffset, backendLogAvailable } from '../helpers/backend-log';
import { score } from '../helpers/sentinel';
import { uniqueSuffix } from '../helpers/ids';

/**
 * Watcher 3 — the Habits Watcher (`behaviour`, LightGBM).
 *
 * MEASURED BEHAVIOUR — read this before trusting DEMO_PRESENTATION.md §7.
 *
 * The doc's claim is that logging in from a new country seconds after a domestic
 * login is scored HIGH on "impossible travel", with the reason "unusual new
 * country for this customer". Against this bundle, the country has **no effect
 * on the score at all**. Controlled experiment, feature store flushed, two fresh
 * users each given one prior IN login, then a second login one second later:
 *
 *   user A  2nd login from IN  -> 0.345132        user B  2nd login from NL -> 0.188230
 *   (repeat, assignment swapped)
 *   user A  2nd login from NL  -> 0.345132        user B  2nd login from IN -> 0.345132
 *
 * Identical inputs bar the country produce identical scores, and across runs the
 * FOREIGN login scored lower as often as higher. The variation tracks
 * `f_user_secs_since_last` (sub-second differences in when the event was sent),
 * not `f_user_new_country` — which never appeared in the top SHAP features, and
 * `explanation.reasons` came back empty for every established user.
 *
 * So this spec asserts the part that is real and that can actually break: the
 * mock-VPN country is captured by the browser, survives the axios interceptor,
 * reaches the fraud gateway, and is sent to the model as the client's country;
 * and the login is scored rather than blocked. The country-raises-risk claim is
 * a documented fixme below, not a passing test dressed up as one.
 */
test.describe.configure({ mode: 'serial' });

test('@demo the mock-VPN country reaches the model, and the login is scored not blocked', async ({
  page,
  backend,
  maker,
}) => {
  const seen = new Set<string>(
    (await feed(backend, maker.token, 30))
      .filter((e: any) => e.eventType === 'LOGIN')
      .map((e: any) => e.id),
  );
  const start = logOffset();

  // ---- Home login, then straight back in from the Netherlands -----------
  await loginViaUi(page, CREDS.maker.userId, CREDS.maker.password, 'IN');
  await logoutViaUi(page);

  // Exactly one model call for the second login.
  await expectModelCalls(
    1,
    async () => {
      await loginViaUi(page, CREDS.maker.userId, CREDS.maker.password, 'NL');
    },
    'NL login',
  );

  // ---- The country actually travelled the whole way to the model -------
  // This is the assertion that protects the demo. GEO_ALLOW_MOCK_COUNTRY
  // defaults to false, in which case resolveGeo() drops the header entirely and
  // the model is told nothing about where the login came from.
  if (backendLogAvailable()) {
    const slice = logSince(start);
    expect(
      slice,
      'the backend never scored a LOGIN with country=NL — GEO_ALLOW_MOCK_COUNTRY is probably false',
    ).toMatch(/\[Sentinel \/score\] LOGIN[^\n]*country=NL/);
    expect(slice).toMatch(/\[Sentinel \/score\] LOGIN[^\n]*country=IN/);
  } else {
    test.info().annotations.push({
      type: 'warning',
      description: 'no .artifacts/backend.log — country propagation not verified',
    });
  }

  // ---- Both logins were scored, and neither was blocked ----------------
  const rows = await feed(backend, maker.token, 30);
  const fresh = rows.filter((e: any) => e.eventType === 'LOGIN' && !seen.has(e.id));
  expect(fresh.length, 'expected two new scored LOGIN events').toBeGreaterThanOrEqual(2);
  for (const e of fresh) assertModelVerdict(e, 'login');

  // A login is scored and recorded, never blocked — a false lockout is worse
  // than the risk it would prevent.
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto('/analyst');
  // No networkidle: /analyst polls at 4s/8s so the network never goes idle.
  await expect(page.getByText('Live transaction feed')).toBeVisible();
  await expect(page.getByText('LOGIN').first()).toBeVisible();
});

/**
 * The demo's actual claim, tested directly against the model with the timing
 * confound removed. Currently fails: see the measurements in the file header.
 * Kept visible rather than deleted — this is the gap to close in the model, and
 * a quietly removed test is a gap nobody remembers.
 */
test.fixme(
  'a login from a new country should score higher than one from the usual country (behaviour head ignores country)',
  async ({ request }) => {
    const home = { channel: 'web', device_id: 'dev-1', event_type: 'LOGIN' };
    const userA = `ctl-a-${uniqueSuffix()}`;
    const userB = `ctl-b-${uniqueSuffix()}`;

    // Identical history for both.
    await score(request, { ...home, event_id: `a1-${uniqueSuffix()}`, event_domain: 'behaviour', user_id: userA, country: 'IN', is_foreign_request: 0 });
    await score(request, { ...home, event_id: `b1-${uniqueSuffix()}`, event_domain: 'behaviour', user_id: userB, country: 'IN', is_foreign_request: 0 });

    // Second login: A stays home, B travels impossibly.
    const stay = await score(request, { ...home, event_id: `a2-${uniqueSuffix()}`, event_domain: 'behaviour', user_id: userA, country: 'IN', is_foreign_request: 0 });
    const travel = await score(request, { ...home, event_id: `b2-${uniqueSuffix()}`, event_domain: 'behaviour', user_id: userB, country: 'NL', is_foreign_request: 1 });

    expect(travel.risk_score).toBeGreaterThan(stay.risk_score);
  },
);

test('the browser really sends X-Mock-Country', async ({ page }) => {
  // Separates "the frontend never sent it" from "the backend ignored it".
  const waiting = page.waitForRequest(
    (r) => r.url().includes('/api/auth/login') && r.method() === 'POST',
  );
  await loginViaUi(page, CREDS.maker.userId, CREDS.maker.password, 'NL');
  expect((await waiting).headers()['x-mock-country']).toBe('NL');
});

test('selecting Auto clears the persisted mock country', async ({ page }) => {
  // A leaked value silently poisons every later spec's payment scoring.
  await page.goto('/login');
  await page.selectOption('#mock-country', 'NL');
  expect(await page.evaluate(() => localStorage.getItem('mock-country'))).toBe('NL');
  await page.selectOption('#mock-country', '');
  expect(await page.evaluate(() => localStorage.getItem('mock-country'))).toBeNull();
});

test('a wrong CAPTCHA is rejected client-side and never reaches the API', async ({ page }) => {
  // Documents that the CAPTCHA is purely a frontend stub — LoginDto.captcha is
  // @IsOptional() and is never validated server-side.
  await page.goto('/login');
  await label(page, 'Customer Id').fill(CREDS.customerId);
  await label(page, 'User Id').fill(CREDS.maker.userId);
  await label(page, 'Password').fill(CREDS.maker.password);
  await page.getByLabel('CAPTCHA answer').fill('WRONG1');

  let loginCalled = false;
  page.on('request', (r) => {
    if (r.url().includes('/api/auth/login')) loginCalled = true;
  });
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByText('CAPTCHA does not match')).toBeVisible();
  expect(loginCalled).toBe(false);
  await expect(page).toHaveURL(/\/login/);
});
