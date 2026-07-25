import { request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  ARTIFACTS,
  BACKEND,
  BACKEND_DIR,
  CREDS,
  FRONTEND,
  REPO_ROOT,
  SENTINEL,
  SENTINEL_KEY,
} from './helpers/env';
import { apiLogin } from './helpers/api';
import { scoredTotal } from './helpers/sentinel';

/**
 * Preflight. Every failure names the exact command that fixes it, because the
 * alternative — a red spec 40 seconds in — tells you nothing about which of the
 * four processes is wrong.
 */

function die(what: string, fixes: string[]): never {
  throw new Error(
    `\n\n${'='.repeat(74)}\n  E2E PREFLIGHT FAILED\n  ${what}\n${'='.repeat(74)}\n` +
      fixes.map((f) => `  -> ${f}`).join('\n') +
      '\n\n',
  );
}

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const api = await request.newContext();

  // ---- 1. The model is up and ready -------------------------------------
  let readyBody: any;
  try {
    const res = await api.get(`${SENTINEL}/ready`, { timeout: 5_000 });
    readyBody = await res.json();
    if (res.status() !== 200 || !readyBody.ready) {
      die(`Sentinel /ready -> HTTP ${res.status()} ${JSON.stringify(readyBody)}`, [
        'scorer_loaded=false -> SENTINEL_MODELS_DIR is wrong, or a bundle failed the',
        '                       CONTRACT_HASH check in service/app.py.',
        'store_ok=false      -> the feature store is down: docker compose up -d redis',
        'store_breaker=open  -> the store circuit tripped; restart the api container.',
      ]);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('PREFLIGHT')) throw err;
    die(`The Sentinel model service is unreachable at ${SENTINEL}.`, [
      'cd ../sentinel_fusion_ai && docker compose up -d',
      'docker start sentinel_fusion_ai-api-1',
      `curl ${SENTINEL}/ready    # expect {"ready":true,...}`,
      'Use 127.0.0.1, not localhost — Node resolves localhost to ::1 and times out.',
    ]);
  }
  console.log(
    `[preflight] model ready  version=${readyBody.model_version}  ` +
      `contract=${readyBody.contract_hash}  breaker=${readyBody.store_breaker}`,
  );

  // ---- 2. Warm the SHAP explainer ---------------------------------------
  // The first ?explain=true call builds the TreeExplainer (~6s cold). The backend
  // fires its own SentinelWarmup at boot, but that is best-effort and silent on
  // failure, so warm it here and report how long a WARM call takes — if that is
  // anywhere near SENTINEL_TIMEOUT_MS, the money path will fail open.
  let lastMs = 0;
  for (const attempt of [1, 2]) {
    const t0 = Date.now();
    const res = await api.post(`${SENTINEL}/score?explain=true`, {
      headers: { 'X-API-Key': SENTINEL_KEY, 'Content-Type': 'application/json' },
      data: {
        event_id: `e2e-warmup:${Date.now()}:${attempt}`,
        event_domain: 'financial',
        event_time: new Date().toISOString(),
        user_id: 'e2e-warmup',
        event_type: 'PAYMENT_INITIATE',
        amount: 1000,
        currency: 'INR',
        payment_type: 'transfer',
        is_credit: 0,
      },
      timeout: 45_000,
    });
    lastMs = Date.now() - t0;
    if (!res.ok()) {
      die(`SHAP warmup POST /score -> HTTP ${res.status()}: ${await res.text()}`, [
        '422 -> an unknown field was sent (EventIn is extra="forbid"), OR event_time was',
        '       naive (no timezone) / more than 300s in the future.',
        '401 -> SENTINEL_REQUIRE_AUTH=true and X-API-Key does not match.',
        '501 -> explanations are disabled (SENTINEL_ENABLE_EXPLAIN=false).',
      ]);
    }
  }
  console.log(`[preflight] SHAP warm; warm /score took ${lastMs}ms`);
  if (lastMs > 2_000) {
    console.warn(
      `[preflight] WARNING: a WARM /score took ${lastMs}ms. SENTINEL_TIMEOUT_MS must ` +
        `comfortably exceed this or HttpScorer will fail open to the heuristic.`,
    );
  }

  // The API specs (03/04/05) talk only to the model. When the suite is filtered
  // to those, skip every bank-dependent preflight so `npm run e2e:api` works
  // without Postgres, Nest or Next running at all.
  if (process.env.E2E_SKIP_BANK === '1') {
    console.log('[preflight] E2E_SKIP_BANK=1 — model-only run, skipping bank checks');
    await api.dispose();
    return;
  }

  // ---- 3. Backend + database --------------------------------------------
  let health: any;
  try {
    const res = await api.get(`${BACKEND}/api/health`, { timeout: 10_000 });
    health = await res.json();
  } catch {
    die(`The backend is not answering at ${BACKEND}/api/health.`, [
      'npm run dev:backend',
      'It must be started with SENTINEL_ENABLED=true and GEO_ALLOW_MOCK_COUNTRY=true —',
      'there is NO dotenv loader in the backend, so a .env file is not enough. Export them.',
      'See: npm run e2e:env  (prints a ready-made export block)',
    ]);
  }
  if (health.db !== 'up') {
    die(`The backend is up but Postgres is not (health.db="${health.db}").`, [
      'npm run up          # docker compose up -d (postgres publishes on host 5433)',
      'npm run db:migrate',
      'Check DATABASE_URL points at localhost:5433, not 5432.',
    ]);
  }

  // ---- 4. Frontend -------------------------------------------------------
  try {
    const res = await api.get(FRONTEND, { timeout: 30_000 });
    if (res.status() >= 400) die(`Frontend -> HTTP ${res.status()}`, ['check the next dev log']);
  } catch (err) {
    if (err instanceof Error && err.message.includes('PREFLIGHT')) throw err;
    die(`The frontend is not answering at ${FRONTEND}.`, ['npm run dev:frontend']);
  }

  // ---- 5. Reset demo data ------------------------------------------------
  if (process.env.E2E_SKIP_SEED !== '1') {
    try {
      execFileSync('npm', ['run', 'prisma:seed', '--workspace', 'apps/backend'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
    } catch {
      console.warn('[preflight] prisma:seed failed — continuing with existing data');
    }
    // The seed's customer.upsert uses `update: {}`, so a SUSPENDED customer left
    // by a previous BLOCKED payment survives every reseed. Nothing currently
    // READS Customer.status, so this is latent rather than an active lockout —
    // clear it anyway so the demo screens look right.
    try {
      execFileSync(
        'npx',
        ['prisma', 'db', 'execute', '--schema', 'prisma/schema.prisma', '--stdin'],
        {
          cwd: BACKEND_DIR,
          stdio: ['pipe', 'ignore', 'ignore'],
          input: `UPDATE customers SET status = 'ACTIVE' WHERE "customerId" = '${CREDS.customerId}';`,
        },
      );
    } catch {
      console.warn('[preflight] could not reset customer status — continuing');
    }
  }

  // ---- 6. Flush the model's feature store (default ON) -------------------
  //
  // The behaviour model LEARNS. Its per-user country set is persisted in Redis
  // (AOF, 90-day TTL), so once NL has been seen for TARAKESH it is never "new"
  // again and the impossible-travel signal simply stops appearing — the demo
  // doc says so itself in §7.4. Measured: on a warm store the NL login scored
  // no higher than the IN login and spec 02 failed for that reason alone.
  //
  // Flushing is therefore the DEFAULT here rather than an opt-in: a test
  // environment that silently decays is worse than one that resets. Opt out
  // with E2E_KEEP_FEATURE_STORE=1 when you deliberately want warm history.
  if (process.env.E2E_KEEP_FEATURE_STORE === '1') {
    console.log('[preflight] keeping the feature store warm (E2E_KEEP_FEATURE_STORE=1)');
  } else {
    try {
      execFileSync('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', 'FLUSHALL'], {
        cwd: `${REPO_ROOT}/../sentinel_fusion_ai`,
        stdio: 'ignore',
      });
      // Workers are spawned after globalSetup, so they inherit this.
      process.env.E2E_FRESH_FEATURE_STORE = '1';
      console.log('[preflight] Sentinel feature store FLUSHED — strict assertions enabled');
    } catch {
      console.warn(
        '[preflight] could not flush the feature store — spec 02 will fall back to a\n' +
          '            relative assertion and may fail if NL is already known to the model.\n' +
          '            Flush manually: cd ../sentinel_fusion_ai && docker compose exec -T redis redis-cli FLUSHALL',
      );
    }
  }

  // ---- 7+8. PROBES: is the model wired, and is the mock country honoured? -
  //
  // Both are read from the backend's tee'd stdout rather than the model's
  // /metrics counter. The model runs `uvicorn --workers 2` and prometheus_client
  // counters are per-process, so consecutive scrapes hit different workers and
  // disagree (measured: alternating 7 rows and 0 on an idle service). A counter
  // delta is a usable POSITIVE signal but proves nothing when flat, so it cannot
  // back a "the model was never called" failure.
  //
  // HttpScorer logs one line per successful model call, in the single Nest
  // process, and it carries the resolved country too:
  //   [Sentinel /score] LOGIN (login:...) country=RU ->
  // RU is used because no spec uses it.
  const logPath = `${ARTIFACTS}/backend.log`;
  if (fs.existsSync(logPath)) {
    const before = (fs.readFileSync(logPath, 'utf8').match(/\[Sentinel \/score\]/g) ?? []).length;
    await apiLogin(api, CREDS.maker.userId, CREDS.maker.password, 'RU');
    await new Promise((r) => setTimeout(r, 1_000)); // tee buffers
    const log = fs.readFileSync(logPath, 'utf8');
    const after = (log.match(/\[Sentinel \/score\]/g) ?? []).length;

    if (after <= before) {
      die('The backend did NOT call the Sentinel model when scoring a login.', [
        'SENTINEL_ENABLED defaults to FALSE -> the HeuristicScorer answers, not the ML model.',
        'SENTINEL_URL must be http://127.0.0.1:8000 for a host-run backend',
        '   (localhost -> ::1 -> ETIMEDOUT; host.docker.internal only resolves inside Docker).',
        'SENTINEL_TIMEOUT_MS defaults to 800ms, below the cold SHAP call. HttpScorer catches',
        '   EVERY error and silently returns heuristic output.',
        'The backend console must print: [FraudModule] SCORER -> Sentinel HttpScorer (...)',
        'There is NO dotenv loader — export these: eval "$(npm run --silent e2e:env)"',
      ]);
    }
    if (/failing open to heuristic/.test(log)) {
      die('HttpScorer has ALREADY fallen back to the heuristic.', [
        'grep "failing open to heuristic" .artifacts/backend.log',
        'Raise SENTINEL_TIMEOUT_MS and/or fix SENTINEL_URL.',
      ]);
    }
    if (!/\[Sentinel \/score\] LOGIN[^\n]*country=RU/.test(log)) {
      die('GEO_ALLOW_MOCK_COUNTRY is not being honoured — X-Mock-Country was ignored.', [
        'It defaults to FALSE, which makes the mock-VPN selector a no-op and spec 02 unfirable.',
        'Export GEO_ALLOW_MOCK_COUNTRY=true on the backend process.',
        `Observed: ${(log.match(/\[Sentinel \/score\] LOGIN[^\n]*/g) ?? ['<none>']).slice(-1)[0]}`,
      ]);
    }
    console.log(
      `[preflight] model reached (${before} -> ${after} scored) and GEO_ALLOW_MOCK_COUNTRY confirmed`,
    );
  } else {
    // Fall back to the counter as a positive-only check: a rise proves the model
    // was called; a flat reading is inconclusive and must NOT fail the run.
    const before = await scoredTotal(api);
    await apiLogin(api, CREDS.maker.userId, CREDS.maker.password, 'RU');
    const after = await scoredTotal(api);
    console.warn(
      `[preflight] no ${logPath} — running degraded.\n` +
        `            sentinel_scored_total ${before} -> ${after} (per-worker; flat is inconclusive)\n` +
        `            Start the backend with: npm run dev:backend:demo\n` +
        `            That tees stdout to .artifacts/backend.log and enables the exact checks.`,
    );
  }

  await api.dispose();
}
