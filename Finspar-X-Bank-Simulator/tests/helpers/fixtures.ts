import { test as base, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ARTIFACTS, BACKEND, CREDS } from './env';
import { apiLogin, resolveAuthorizerPassword, type Session } from './api';
import { seedSession } from './ui';

const BACKEND_LOG = path.join(ARTIFACTS, 'backend.log');

interface Fixtures {
  /** Request context aimed at the bank API. */
  backend: APIRequestContext;
  maker: Session;
  authorizer: Session;
  /** Pre-authenticated AUTHORIZER page (skips the login UI). */
  authorizerPage: Page;
  /** Auto-use: fails the test if HttpScorer fell back to the heuristic. */
  noFailOpen: void;
}

export const test = base.extend<Fixtures>({
  backend: async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext({
      extraHTTPHeaders: { 'Content-Type': 'application/json' },
    });
    await use(ctx);
    await ctx.dispose();
  },

  maker: async ({ backend }, use) => {
    await use(await apiLogin(backend, CREDS.maker.userId, CREDS.maker.password, 'IN'));
  },

  authorizer: async ({ backend }, use) => {
    const pw = await resolveAuthorizerPassword(backend);
    await use(await apiLogin(backend, CREDS.authorizerId, pw, 'IN'));
  },

  authorizerPage: async ({ browser, authorizer }, use) => {
    const ctx = await browser.newContext();
    await seedSession(ctx, authorizer);
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },

  /**
   * Layer 3 of the fail-open guard, and the only one that catches a TIMEOUT.
   *
   * Layers 1 (reason signatures) and 2 (sentinel_scored_total delta) catch "the
   * model was never called". Neither catches "the model scored it but axios gave
   * up first" — for that, HttpScorer logs
   *   "Sentinel /score failed (<code>); failing open to heuristic"
   * and that line only exists in the backend's stdout. Reading the slice of the
   * log produced during this test is the only way to see it.
   *
   * Degrades to a warning annotation when the log isn't being captured (i.e.
   * the backend was started by hand rather than tee'd to .artifacts).
   */
  noFailOpen: [
    async ({}, use, testInfo) => {
      const start = fs.existsSync(BACKEND_LOG) ? fs.statSync(BACKEND_LOG).size : -1;
      await use();
      if (start < 0) {
        testInfo.annotations.push({
          type: 'warning',
          description:
            'No .artifacts/backend.log — fail-open guard degraded to layers 1+2. Pipe the backend through tee to enable it.',
        });
        return;
      }
      const end = fs.statSync(BACKEND_LOG).size;
      if (end <= start) return;
      const fd = fs.openSync(BACKEND_LOG, 'r');
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const offenders = buf
        .toString('utf8')
        .split('\n')
        .filter((l) => /failing open to heuristic|returned scored=false/.test(l));
      if (offenders.length) {
        throw new Error(
          'HttpScorer fell back to the heuristic DURING this test — any model assertion ' +
            'above may have passed for the wrong reason:\n' +
            offenders.join('\n'),
        );
      }
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
export { BACKEND, CREDS };
