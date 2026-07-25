import { test, expect } from '@playwright/test';
import { BACKEND } from '../helpers/env';

/**
 * The demo test-runner panel on the login page.
 *
 * NOTE: this spec runs INSIDE the suite the panel launches, so it must never
 * click a run button — that would recurse (the panel's single-run mutex would
 * reject it, but the intent would still be wrong). It asserts the panel's
 * presence, its buttons, and the runner API's safety behaviour directly.
 */
test.describe.configure({ mode: 'serial' });

const runnerMounted = async (request: any): Promise<boolean> => {
  const res = await request.get(`${BACKEND}/api/demo-tests/specs`).catch(() => null);
  return !!res?.ok();
};

test('the panel offers one button per watcher plus "Test all scripts"', async ({
  page,
  request,
}) => {
  test.skip(!(await runnerMounted(request)), 'DEMO_TEST_RUNNER is off — panel intentionally hidden');

  await page.goto('/login');
  const panel = page.getByTestId('demo-test-panel');
  await expect(panel).toBeVisible();

  for (const id of ['money', 'habits', 'intrusion', 'quantum', 'command-center']) {
    await expect(page.getByTestId(`run-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('run-all')).toBeVisible();

  // The panel must not interfere with the login form it sits beneath.
  await expect(page.locator('input[name="customerId"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
});

test('the runner rejects anything outside its allowlist', async ({ request }) => {
  test.skip(!(await runnerMounted(request)), 'DEMO_TEST_RUNNER is off');

  // No caller-supplied path, flag or grep expression may reach the process.
  for (const spec of ['../../etc/passwd', 'money; rm -rf /', '', 'all2']) {
    const res = await request.post(`${BACKEND}/api/demo-tests/run`, { data: { spec } });
    expect(res.status(), `spec=${JSON.stringify(spec)} must be rejected`).toBe(400);
  }
});

test('the spec list is exactly the allowlist', async ({ request }) => {
  test.skip(!(await runnerMounted(request)), 'DEMO_TEST_RUNNER is off');

  const { specs } = await (await request.get(`${BACKEND}/api/demo-tests/specs`)).json();
  expect(specs.map((s: any) => s.id).sort()).toEqual(
    ['all', 'command-center', 'habits', 'intrusion', 'money', 'quantum'].sort(),
  );
});

test('an unknown runId is a 404, not a crash', async ({ request }) => {
  test.skip(!(await runnerMounted(request)), 'DEMO_TEST_RUNNER is off');

  const res = await request.get(`${BACKEND}/api/demo-tests/status/not-a-real-run`);
  expect(res.status()).toBe(404);
});
