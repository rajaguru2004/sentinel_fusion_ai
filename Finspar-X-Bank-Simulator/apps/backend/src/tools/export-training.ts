/**
 * Training / calibration export generator (MODEL_INTEGRATION_PLAN.md Step 10).
 *
 * Produces the labeled event corpus Sentinel Fusion AI trains and calibrates on,
 * to the contract in `sentinel_fusion_ai/docs/finspark_export_spec.md`. The
 * simulator has no real multi-year history, so this SYNTHESIZES a realistic
 * corpus that honours the spec's guarantees:
 *   - newline-delimited JSON, camelCase keys, one object per event
 *   - ascending eventTime within a customer; ties broken by eventId
 *   - complete sequences per customer (never subsample a customer)
 *   - fraud rate 0.1–1.0%, NOT pre-balanced
 *   - median ≥ 200 events/customer, ≥ 6 months span
 *   - every label.value != -1 carries confirmedAt (>= eventTime)
 *   - NO label-derived fields (severity/riskScore/isFlagged) in the payload
 *
 * Dependency-free (node builtins only) so it runs standalone:
 *   npm run export:training -- --customers 5000 --out ./exports/finspark
 * Defaults produce a spec-valid corpus; pass --customers 50 for a quick smoke test.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// --------------------------------------------------------------- config ----
interface Config {
  customers: number;
  months: number;
  fraudRate: number; // target fraud fraction of labeled scored events
  seed: number;
  outDir: string;
  eventsPerFile: number;
}

function parseArgs(argv: string[]): Config {
  const get = (flag: string, def?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  return {
    customers: Number(get('--customers', '5000')),
    months: Number(get('--months', '6')),
    fraudRate: Number(get('--fraud-rate', '0.008')),
    seed: Number(get('--seed', '42')),
    outDir: resolve(get('--out', './exports/finspark') as string),
    eventsPerFile: Number(get('--events-per-file', '250000')),
  };
}

// -------------------------------------------------------- deterministic RNG -
/** mulberry32 — small, fast, seedable PRNG so exports are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------- helpers ----
const CHANNELS = ['web', 'mobile', 'atm', 'pos', 'branch', 'api'] as const;
const DEVICE_OS = ['Android', 'iOS', 'Windows', 'macOS'] as const;
const PAYMENT_TYPES = ['transfer', 'cash_out', 'cash_in', 'debit', 'payment'] as const;
const MERCHANT_CATS = ['grocery_pos', 'travel', 'electronics', 'fuel', 'apparel', 'dining'] as const;
// India bounding box-ish for synthetic geo.
const GEO = { latMin: 8.4, latMax: 33.5, lonMin: 68.7, lonMax: 92.0 };

const round2 = (n: number): number => Math.round(n * 100) / 100;
const pick = <T>(r: () => number, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)];
const between = (r: () => number, lo: number, hi: number): number => lo + r() * (hi - lo);
const intBetween = (r: () => number, lo: number, hi: number): number => Math.floor(between(r, lo, hi + 1));

interface Stats {
  total: number;
  scored: number;
  fraud: number;
  perCustomer: number[];
  minTime: number;
  maxTime: number;
  bankComputedOnPayments: number;
  paymentCount: number;
}

// --------------------------------------------------------------- generate ---
function run(cfg: Config): void {
  mkdirSync(cfg.outDir, { recursive: true });
  const r = mulberry32(cfg.seed);

  const spanMs = cfg.months * 30 * 24 * 3600 * 1000;
  const startMs = Date.now() - spanMs;

  const stats: Stats = {
    total: 0,
    scored: 0,
    fraud: 0,
    perCustomer: [],
    minTime: Infinity,
    maxTime: -Infinity,
    bankComputedOnPayments: 0,
    paymentCount: 0,
  };

  let fileSeq = 1;
  let inFile = 0;
  let stream = openFile(cfg, fileSeq);

  const writeEvent = (e: Record<string, unknown>): void => {
    stream.write(JSON.stringify(e) + '\n');
    stats.total += 1;
    inFile += 1;
    const t = Date.parse(e.eventTime as string);
    if (t < stats.minTime) stats.minTime = t;
    if (t > stats.maxTime) stats.maxTime = t;
    if (inFile >= cfg.eventsPerFile) {
      stream.end();
      fileSeq += 1;
      inFile = 0;
      stream = openFile(cfg, fileSeq);
    }
  };

  for (let c = 0; c < cfg.customers; c++) {
    generateCustomer(c, r, startMs, spanMs, cfg, writeEvent, stats);
  }
  stream.end();

  report(cfg, stats);
}

function openFile(cfg: Config, seq: number): ReturnType<typeof createWriteStream> {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const path = join(cfg.outDir, `events_${day}_${String(seq).padStart(3, '0')}.jsonl`);
  return createWriteStream(path, { encoding: 'utf8' });
}

function generateCustomer(
  c: number,
  r: () => number,
  startMs: number,
  spanMs: number,
  cfg: Config,
  write: (e: Record<string, unknown>) => void,
  stats: Stats,
): void {
  const userId = `cust-${c}`;
  const deviceId = `dev-${c}-${intBetween(r, 1, 3)}`;
  const homeLat = round2(between(r, GEO.latMin, GEO.latMax));
  const homeLon = round2(between(r, GEO.lonMin, GEO.lonMax));
  const os = pick(r, DEVICE_OS);
  const customerAge = intBetween(r, 21, 75);
  const accountAgeSeconds = Math.floor(between(r, 90, 3650) * 24 * 3600); // 90d–10y
  const income = round2(between(r, 0.1, 0.95));
  const emailIsFree = r() < 0.6 ? 1 : 0;
  // A small slice of customers are fraud-prone (models repeat offenders — spec Q4).
  const fraudProne = r() < 0.03;
  const userMean = between(r, 1500, 40000);

  // Event count per customer, centred well above the 200 median requirement.
  const eventCount = intBetween(r, 190, 420);
  stats.perCustomer.push(eventCount);

  // Beneficiary pool grows over time; each has an activation time.
  const benes: { id: string; activatedAt: number; isOwnBank: boolean; balance: number }[] = [];
  let balance = between(r, 5000, 500000);

  // Timestamps march forward monotonically across the span.
  let t = startMs + between(r, 0, spanMs * 0.05);
  const step = spanMs / (eventCount + 1);

  for (let i = 0; i < eventCount; i++) {
    t += between(r, step * 0.3, step * 1.7);
    if (t > startMs + spanMs) t = startMs + spanMs - 1;
    const eventTime = new Date(t).toISOString();
    const eventId = `evt_${c}_${i}`;
    const sessionId = `sess-${c}-${Math.floor(i / 12)}`;
    const channel = pick(r, CHANNELS);
    const envelope = {
      eventId,
      eventTime,
      userId,
      deviceId,
      sessionId,
      channel,
      country: 'IN',
    };

    const roll = r();
    if (roll < 0.15) {
      // login (scored by behaviour) — mostly benign, rare ATO.
      const ato = fraudProne && r() < 0.01;
      write({
        ...envelope,
        eventType: 'login',
        device: { os, isNew: r() < 0.05 ? 1 : 0, sessionLengthSeconds: intBetween(r, 20, 1800), isForeignRequest: 0 },
        geo: { lat: homeLat, lon: homeLon },
        label: label(t, ato ? 1 : 0, ato ? 'account_takeover' : 'none', r),
      });
      stats.scored += 1;
      if (ato) stats.fraud += 1;
    } else if (roll < 0.2 && benes.length < 15) {
      // beneficiary_add (context) — starts the ageing clock.
      const b = { id: `bene-${c}-${benes.length}`, activatedAt: 0, isOwnBank: r() < 0.4, balance: between(r, 200, 80000) };
      benes.push(b);
      write({ ...envelope, eventType: 'beneficiary_add', counterparty: { id: b.id, country: 'IN' }, label: unlabeled() });
    } else if (roll < 0.24) {
      // beneficiary_activate (context).
      const pending = benes.find((b) => b.activatedAt === 0);
      if (pending) {
        pending.activatedAt = t;
        write({ ...envelope, eventType: 'beneficiary_activate', counterparty: { id: pending.id, country: 'IN' }, label: unlabeled() });
      } else {
        write({ ...envelope, eventType: 'balance_check', label: unlabeled() });
      }
    } else if (roll < 0.45) {
      // context views — build velocity/history.
      write({ ...envelope, eventType: r() < 0.5 ? 'balance_check' : 'statement_view', label: unlabeled() });
    } else if (roll < 0.6) {
      // card_purchase (scored) — comparable to Sparkov.
      const amount = round2(between(r, 100, 15000));
      write({
        ...envelope,
        eventType: 'card_purchase',
        amount,
        currency: 'INR',
        isCredit: 0,
        merchant: {
          id: `mrc-${intBetween(r, 1, 500)}`,
          category: pick(r, MERCHANT_CATS),
          lat: round2(between(r, GEO.latMin, GEO.latMax)),
          lon: round2(between(r, GEO.lonMin, GEO.lonMax)),
        },
        device: { os, isNew: 0, sessionLengthSeconds: intBetween(r, 20, 900), isForeignRequest: 0 },
        geo: { lat: homeLat, lon: homeLon },
        label: label(t, 0, 'none', r),
      });
      stats.scored += 1;
    } else {
      // payment_initiation (the primary training target).
      const active = benes.filter((b) => b.activatedAt > 0 && b.activatedAt <= t);
      const bene = active.length > 0 ? pick(r, active) : undefined;
      const beneAgeMin = bene ? Math.max(0, (t - bene.activatedAt) / 60000) : undefined;
      const isNewBene = beneAgeMin != null && beneAgeMin < 60;

      // Decide fraud for this payment. Concentrated in fraud-prone customers so
      // the per-customer positive rate is realistic (repeat offenders).
      const baseP = fraudProne ? cfg.fraudRate * 25 : cfg.fraudRate * 0.3;
      const isFraud = r() < baseP;

      const amount = isFraud
        ? round2(userMean * between(r, 6, 40)) // fraud skews high vs the user's mean
        : round2(userMean * between(r, 0.2, 3));
      const nameMismatch = isFraud ? (r() < 0.7 ? 1 : 0) : r() < 0.03 ? 1 : 0;

      const balanceBefore = round2(balance);
      balance = Math.max(0, balance - amount);
      const balanceAfter = round2(balance);

      const cpBefore = bene?.isOwnBank ? round2(bene.balance) : undefined;
      const cpAfter = cpBefore != null ? round2(cpBefore + amount) : undefined;

      write({
        ...envelope,
        eventType: 'payment_initiation',
        amount,
        currency: 'INR',
        paymentType: pick(r, PAYMENT_TYPES),
        isCredit: 0,
        balanceBefore,
        balanceAfter,
        counterparty: bene
          ? {
              id: bene.id,
              country: 'IN',
              isNew: isNewBene ? 1 : 0,
              ageSeconds: beneAgeMin != null ? Math.round(beneAgeMin * 60) : undefined,
              nameMismatch,
              balanceBefore: cpBefore,
              balanceAfter: cpAfter,
              lat: round2(between(r, GEO.latMin, GEO.latMax)),
              lon: round2(between(r, GEO.lonMin, GEO.lonMax)),
            }
          : undefined,
        customer: { age: customerAge, accountAgeSeconds, income, emailIsFree },
        device: { os, isNew: 0, sessionLengthSeconds: intBetween(r, 20, 1200), isForeignRequest: isFraud && r() < 0.4 ? 1 : 0 },
        geo: { lat: homeLat, lon: homeLon },
        // The bank's own signals — trained as an independent view + cold-store
        // fallback. Always present here (spec wants >= 60% of payments).
        bankComputed: {
          txnCountLastHour: isFraud ? intBetween(r, 8, 30) : intBetween(r, 0, 6),
          amountVsUserMean: round2(amount / userMean),
          beneficiaryAgeMinutes: beneAgeMin != null ? Math.round(beneAgeMin) : undefined,
          isNewBeneficiary: isNewBene,
        },
        label: label(t, isFraud ? 1 : 0, isFraud ? 'fraud' : 'none', r),
      });
      stats.scored += 1;
      stats.paymentCount += 1;
      stats.bankComputedOnPayments += 1;
      if (isFraud) stats.fraud += 1;
    }
  }
}

// ----------------------------------------------------------------- labels ---
/** Labeled outcome. confirmedAt = when the bank *learned* the truth (lagged). */
function label(eventMs: number, value: 0 | 1, type: string, r: () => number): Record<string, unknown> {
  // Benign clears fast (settlement); fraud is learned days later (chargeback/SOC).
  const lagDays = value === 1 ? between(r, 3, 45) : between(r, 0.2, 7);
  const confirmedAt = new Date(eventMs + lagDays * 24 * 3600 * 1000).toISOString();
  const source = value === 1 ? (r() < 0.6 ? 'chargeback' : 'soc_review') : 'rule';
  return { value, type, confirmedAt, source };
}

/** Context events are unlabeled — feature history only, never supervised. */
function unlabeled(): Record<string, unknown> {
  return { value: -1, type: 'none' };
}

// ----------------------------------------------------------------- report ---
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function report(cfg: Config, s: Stats): void {
  const fraudRate = s.scored > 0 ? s.fraud / s.scored : 0;
  const med = median(s.perCustomer);
  const spanDays = (s.maxTime - s.minTime) / (24 * 3600 * 1000);
  const pctBankComputed = s.paymentCount > 0 ? s.bankComputedOnPayments / s.paymentCount : 0;

  // Spec's on-receipt assertions — surface pass/fail so the run is self-checking.
  const checks = [
    ['fraud rate within 0.05%–2.0%', fraudRate >= 0.0005 && fraudRate <= 0.02, `${(fraudRate * 100).toFixed(3)}%`],
    ['median events/customer >= 200', med >= 200, String(med)],
    ['span >= 6 months (~180d)', spanDays >= 175, `${spanDays.toFixed(0)}d`],
    ['bankComputed on >= 60% of payments', pctBankComputed >= 0.6, `${(pctBankComputed * 100).toFixed(0)}%`],
  ] as const;

  console.log('\n── FinSpark training export ─────────────────────────────');
  console.log(`output dir     : ${cfg.outDir}`);
  console.log(`customers      : ${cfg.customers}`);
  console.log(`total events   : ${s.total.toLocaleString()}`);
  console.log(`scored events  : ${s.scored.toLocaleString()}`);
  console.log(`fraud events   : ${s.fraud.toLocaleString()} (${(fraudRate * 100).toFixed(3)}%)`);
  console.log(`median / cust  : ${med}`);
  console.log(`span           : ${spanDays.toFixed(0)} days`);
  console.log('── spec checks ──────────────────────────────────────────');
  let allPass = true;
  for (const [name, ok, val] of checks) {
    if (!ok) allPass = false;
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}  (${val})`);
  }
  console.log(allPass ? '\nAll spec checks passed.' : '\nSome checks FAILED — adjust --customers/--fraud-rate.');
  if (s.total < 2_000_000) {
    console.log(`\nNote: ${s.total.toLocaleString()} events. Full corpus target is >= 2,000,000 —`);
    console.log('run with --customers 9000 (or more) for a production-sized export.');
  }
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2)));
}

export { run, parseArgs };
