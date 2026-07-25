import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { CREDS } from './env';
import type { Session } from './api';

/**
 * Label matcher for the shared Input/Select components.
 *
 * Two traps, both load-bearing:
 *  1. ids come from useId(), so they are React-generated (`«r0»`) — never
 *     hardcode one.
 *  2. the components render `{label}<span>*</span>` with NO whitespace, so the
 *     accessible name of a required field is "Password*", not "Password".
 *     getByLabel('Password', {exact:true}) therefore fails, while a loose
 *     substring match makes 'Account Number' also hit 'Confirm Account Number'
 *     and trip strict mode. Anchoring with an optional trailing * fixes both.
 */
export const label = (scope: Page | Locator, text: string): Locator =>
  scope.getByLabel(new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\*?$`));

export async function loginViaUi(
  page: Page,
  userId: string,
  password: string,
  mockCountry = '',
): Promise<void> {
  await page.goto('/login');

  await label(page, 'Customer Id').fill(CREDS.customerId);
  await label(page, 'User Id').fill(userId);
  await label(page, 'Password').fill(password);

  // Set the mock VPN BEFORE submitting: the handler writes
  // localStorage['mock-country'], which the axios interceptor reads when it
  // POSTs /auth/login. Setting it afterwards scores the login with no country.
  await page.selectOption('#mock-country', mockCountry);

  // The CAPTCHA is client-side only. The code is rendered into a .sr-only span,
  // which is clipped — innerText() returns '' and textContent() is required.
  // (It is also rendered visibly, so getByText(code) would be ambiguous.)
  const code = (await page.locator('form span.sr-only').first().textContent())?.trim() ?? '';
  expect(code, 'CAPTCHA code was not rendered').toMatch(
    /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/,
  );
  await page.getByLabel('CAPTCHA answer').fill(code);

  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL('**/dashboard');
  // (app)/layout.tsx renders null until the zustand store rehydrates, then
  // redirects if there is no token. Wait for real chrome before asserting.
  await expect(page.getByRole('link', { name: 'Analyst Dashboard' })).toBeVisible();
}

/**
 * Navigate and wait for the page's react-query fetches to settle.
 *
 * These screens render immediately with `data === undefined`, then re-render
 * when the query lands — which detaches header buttons mid-click ("element was
 * detached from the DOM, retrying" until timeout). None of them poll, so
 * networkidle is safe and is the simplest correct barrier.
 *
 * Do NOT use this for /analyst: four queries there refetch at 4s/8s, so the
 * network never goes idle and this would hang. Use auto-retrying assertions.
 */
export async function gotoSettled(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
}

export async function logoutViaUi(page: Page): Promise<void> {
  await page.getByRole('button', { name: /log ?out/i }).click();
  await page.waitForURL('**/login');
}

/**
 * Fast login for specs not exercising the login UI.
 *
 * addInitScript rather than a storageState file written once in global-setup:
 * the JWT expires (JWT_EXPIRES_IN), and a stale storageState fails as a 401 ->
 * `window.location.href = '/login'` redirect, which reads as "the app randomly
 * logged me out" instead of "the token was old".
 */
export async function seedSession(
  context: BrowserContext,
  session: Session,
  mockCountry = '',
): Promise<void> {
  await context.addInitScript(
    ([s, mc]) => {
      // The axios interceptor reads this raw key.
      localStorage.setItem('finspark-token', (s as any).token);
      // zustand persist envelope; (app)/layout gates on token && user.
      localStorage.setItem(
        'finspark-auth',
        JSON.stringify({ state: { token: (s as any).token, user: (s as any).user }, version: 0 }),
      );
      if (mc) localStorage.setItem('mock-country', mc as string);
      else localStorage.removeItem('mock-country');
    },
    [session, mockCountry] as const,
  );
}
