import path from 'node:path';

/** One source of truth for URLs, credentials and paths. */

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const BACKEND_DIR = path.join(REPO_ROOT, 'apps/backend');
export const ARTIFACTS = path.join(REPO_ROOT, '.artifacts');

export const FRONTEND = process.env.E2E_FRONTEND_URL ?? 'http://localhost:3000';
// 127.0.0.1, not localhost: Node prefers ::1 and would time out.
export const BACKEND = process.env.E2E_BACKEND_URL ?? 'http://127.0.0.1:3001';
export const SENTINEL = process.env.E2E_SENTINEL_URL ?? 'http://127.0.0.1:8000';
export const SENTINEL_KEY = process.env.SENTINEL_API_KEY ?? 'sentinel-demo-key-2026';

export const CREDS = {
  customerId: process.env.E2E_CUSTOMER_ID ?? '83840226',
  maker: {
    userId: process.env.E2E_MAKER_ID ?? 'TARAKESH',
    password: process.env.E2E_MAKER_PASSWORD ?? 'Finspark@123',
  },
  authorizerId: process.env.E2E_AUTHORIZER_ID ?? 'PRIYA_A',
  /**
   * prisma/seed.ts hashes 'Finspark@123' for ALL three users, but
   * DEMO_PRESENTATION.md §4 documents 'NewPass@999'. The seed uses
   * `upsert(..., update: {})`, so a password changed through the UI survives
   * every reseed and the two can legitimately disagree. Resolved at runtime by
   * resolveAuthorizerPassword() rather than guessing.
   */
  authorizerPasswords: [
    process.env.E2E_AUTHORIZER_PASSWORD,
    'Finspark@123',
    'NewPass@999',
  ].filter(Boolean) as string[],
  viewerId: process.env.E2E_VIEWER_ID ?? 'ROHIT_V',
  viewerPassword: process.env.E2E_VIEWER_PASSWORD ?? 'Finspark@123',
  txnPassword: process.env.E2E_TXN_PASSWORD ?? 'Txn@12345',
  otp: process.env.E2E_OTP ?? '123456',
};

/** Set by global-setup when the model's feature store was flushed this run. */
export const freshFeatureStore = (): boolean => process.env.E2E_FRESH_FEATURE_STORE === '1';
