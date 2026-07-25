#!/usr/bin/env node
/**
 * Prints the environment the backend needs for the Sentinel demo.
 *
 * This exists because apps/backend has NO dotenv loader — no ConfigModule, no
 * `dotenv` import; src/common/env.ts reads process.env directly. Writing
 * apps/backend/.env therefore does NOT reliably reach the code that picks the
 * scorer. These must be exported into the process that runs Nest.
 *
 *   eval "$(npm run --silent e2e:env)" && npm run dev:backend:demo
 */
const lines = [
  '# --- FinSpark demo backend environment ---------------------------------',
  '# Routes scoring through the ML model instead of the Phase-1 heuristic.',
  'export SENTINEL_ENABLED=true',
  '# 127.0.0.1, NOT localhost: Node resolves localhost to ::1 and times out.',
  '# NOT host.docker.internal either — that only resolves inside Docker.',
  'export SENTINEL_URL=http://127.0.0.1:8000',
  'export SENTINEL_API_KEY=sentinel-demo-key-2026',
  '# Default is 800ms, below the ~6s cold SHAP call. HttpScorer catches every',
  '# error and silently falls back to the heuristic, so a low value here means',
  '# the demo quietly stops using the model.',
  'export SENTINEL_TIMEOUT_MS=15000',
  '# Honour the login page mock-VPN selector (X-Mock-Country). Without this the',
  '# impossible-travel demo cannot fire at all. DEV ONLY.',
  'export GEO_ALLOW_MOCK_COUNTRY=true',
  'export GEO_DEV_USE_PUBLIC_IP=false',
  '# The HELD -> release -> authorize flow outlives the 100s default OTP TTL',
  '# and the 15m default JWT.',
  'export OTP_TTL_SECONDS=900',
  'export JWT_EXPIRES_IN=60m',
  '# Mounts /api/demo-tests/* for the login-page test panel. UNAUTHENTICATED —',
  '# demo machines only, never a real deployment.',
  'export DEMO_TEST_RUNNER=true',
];
process.stdout.write(lines.join('\n') + '\n');
