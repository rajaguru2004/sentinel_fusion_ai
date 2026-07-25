import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Playwright lives at the simulator root (not a separate workspace) because the
 * suite spans all three processes: the Next.js UI, the NestJS API, and the
 * sibling Python model service.
 *
 * Services are NOT started here. Postgres and the Python model cannot be
 * meaningfully health-gated by `webServer`, and a `webServer` timeout is the
 * least actionable error in this system. `tests/global-setup.ts` probes each one
 * and fails with the exact command to fix it instead.
 */

export const ARTIFACTS = path.join(__dirname, '.artifacts');

const FRONTEND = process.env.E2E_FRONTEND_URL ?? 'http://localhost:3000';
// Node-facing: 127.0.0.1, never "localhost" — Node resolves localhost to ::1
// first and the request times out against an IPv4-only listener.
const SENTINEL = process.env.E2E_SENTINEL_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  testDir: './tests/specs',
  outputDir: path.join(ARTIFACTS, 'test-results'),
  globalSetup: require.resolve('./tests/global-setup'),

  // Shared mutable state everywhere: the ledger, the seeded customer, refNo
  // generation (a SELECT count + 1 race), and the model's per-entity feature
  // store. Serial, always.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,

  // 0 by default: retrying 01-money-watcher re-runs a stateful flow whose
  // beneficiary code and custRefNo already exist. The stateless API specs opt
  // back in per-file.
  retries: 0,

  timeout: 180_000, // spec 01 walks the whole demo end to end
  // /analyst polls at 4s (stats/feed/held) and 8s (cases); an auto-retrying
  // assertion needs to survive several cycles plus a cold SHAP call.
  expect: { timeout: 20_000 },

  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: path.join(ARTIFACTS, 'html-report'), open: 'never' }]]
    : [
        ['list'],
        ['html', { outputFolder: path.join(ARTIFACTS, 'html-report'), open: 'never' }],
      ],

  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Traces and video double as demo backup material, not just debug output.
    trace: 'retain-on-failure',
    video: process.env.E2E_VIDEO === 'off' ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      // No browser is launched: these specs use only the `request` fixture.
      name: 'api',
      testMatch: /0[345]-.*\.spec\.ts$/,
      use: { baseURL: SENTINEL },
    },
    {
      name: 'ui',
      testMatch: /(0[12]|06|07)-.*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: FRONTEND,
        viewport: { width: 1440, height: 900 },
        locale: 'en-IN',
        // Cosmetic only. It does NOT move the NEFT/RTGS 19:30 cut-off, which is
        // evaluated with the BACKEND process's local clock.
        timezoneId: 'Asia/Kolkata',
      },
    },
  ],
});
