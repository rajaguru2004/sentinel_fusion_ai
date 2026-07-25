# Finspar-X — Enhancement Plan (Frontend & Backend)

Hardening and enrichment of the bank simulator (NestJS backend + Next.js
frontend) and its integration with the Sentinel Fusion AI scorer.

**Status: all six items implemented (2026-07-25).** Each section below now
records what was built and why, rather than what was proposed. Verification
state is in [Verification](#verification) — read it before treating any of this
as proven: both apps compile and the backend boots cleanly, but no runtime test
was possible because Docker/Postgres was not running on the build machine.

---

## Baseline — what was already strong

- Proper payment flow: `initiate` (NEW draft) -> `confirm` (fraud gateway ->
  decision) -> OTP + transaction password -> `submit` -> ledger post
  (`apps/backend/src/payments/payments.service.ts`).
- The fraud gateway runs **before** the ledger is touched, persists a
  `FraudEvent`, and the HTTP scorer **fails open** to a heuristic so a model
  outage cannot hang the money path.
- Money is `BigInt` paise end to end, serialised as strings on the wire.
- Double-entry ledger inside a Prisma `$transaction`, with hold/release and a
  cut-off cron.
- Global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted`.
- Credential guessing already capped **per challenge**: OTP verify burns the
  challenge at `env.otpMaxAttempts` (`otp.service.ts`), login locks the user at
  `env.loginMaxAttempts` (`auth.service.ts`).
- A real explainability surface already rendered (`VerdictCard.tsx`).

---

## What shipped

| # | Enhancement | Layer | Priority | Status |
|---|---|---|---|---|
| 1 | Ledger double-spend (TOCTOU) + `runCutoff` hold release + submit idempotency | Backend | **P0** | Done |
| 2 | Rate limiting + security headers + demo-config guard | Backend | **P0** | Done |
| 3 | Observability: fail-open alerting, tracing, readiness | Full-stack | P1 | Done |
| 4 | JWT -> httpOnly cookies (+ CSRF) | Full-stack | P1 | Done |
| 5 | Richer verdict/risk visualization | Frontend | P1 | Done |
| 6 | Real-time analyst console + case correlation | Full-stack | P2 | Done |

---

## 1. Money-path safety — P0

**The TOCTOU race.** `postPayment` read the balance, decided, then wrote
`read − amount`. Being inside `$transaction` is not sufficient: Postgres' default
Read Committed isolation lets two concurrent transactions read the same starting
balance before either writes. Account holding ₹100, two ₹60 payments: both read
100, both check `100 >= 60`, both write 40 — ₹120 leaves a ₹100 account.

**Fixed** with an atomic conditional decrement — `debitIfSufficient()` in
`ledger.service.ts`:

```sql
UPDATE "accounts"
   SET "clearBalance" = "clearBalance" - :amt
 WHERE "id" = :id AND "clearBalance" - "holdAmount" >= :amt
```

Zero rows affected means insufficient funds. Check and write are one indivisible
statement, so no window exists regardless of isolation level.

**The `runCutoff` re-release loop.** The cut-off job decremented `holdAmount` in
its own committed statement and *then* called `postPayment(...).catch(log)`. On
failure the funds were un-held but the payment stayed `HELD`, so the next run
decremented again — driving `holdAmount` negative, which inflates
`clearBalance - holdAmount`, the very quantity the availability check relies on.
No concurrency needed; it compounded on a schedule.

**Fixed** by folding the release into the posting transaction. `postPayment`
detects a `HELD` payment and calls `releaseHoldUpTo()` — a single clamped
statement, `GREATEST("holdAmount" - :amt, 0)`, so releasing an already-released
hold is a no-op rather than a decrement — inside the same `$transaction`. A
failed post now rolls the release back with it, and `runCutoff` simply retries
next run.

**Tolerant, not brittle.** The release deliberately does not *refuse* when the
held amount falls short of the payment. An earlier version did, and it stranded
real payments: this database contains HELD payments whose accounts hold nothing
— the fingerprint of the old release-then-fail loop, still in the data. Refusing
meant those could never be released or rejected by anyone, which is worse than
the inconsistency being guarded against. It now releases what is actually held,
logs the shortfall for reconciliation, and lets the status transition proceed.

**Idempotency.** A `@@unique([paymentId, direction])` index on `ledger_entries`
is the money-path idempotency key: one payment yields exactly one DEBIT and one
CREDIT, so a second post aborts on the constraint. `postPayment` returns
`'POSTED' | 'ALREADY_POSTED'` and treats both the pre-flight status check and a
P2002 race loss as a replay rather than an error.

**No more stranding.** `submit()` captures the prior status before setting
`PROCESSING`; if the post throws (nothing committed, the transaction rolled
back) it restores that status and rethrows, so the payment stays editable and
retryable instead of being frozen in `PROCESSING` forever.

Also hardened: `holdPayment` refuses to double-hold or to hold a completed
payment; `ensureSettlementAccount` moved outside the transaction, because a
P2002 on the account-number unique index would otherwise abort the whole
payment.

Files: `ledger/ledger.service.ts`, `payments/payments.service.ts`,
`prisma/schema.prisma`, `prisma/migrations/20260725120000_ledger_idempotency/`.

---

## 2. Rate limiting + security headers — P0

**The gap was not what the first draft of this document claimed.** Per-credential
guessing was already capped. What was missing:

1. **Request volume** — nothing capped how many *challenges* could be issued; the
   attempt counter resets with every fresh one.
2. **Per-IP spraying** — the caps are per-user-row, so one guess each across many
   user ids trips nothing.
3. **Per-process state** — the `recovery.service.ts` limiter is an in-memory map.

**Shipped.** `@nestjs/throttler` globally via `APP_GUARD`, with tiers defined in
`common/throttler.config.ts` and applied per route with `@ThrottleTier(...)`:

| Tier | Limit/min/IP | Env override | Applied to |
|---|---|---|---|
| `default` | 600 | `THROTTLE_DEFAULT_LIMIT` | everything else |
| `auth` | 20 | `THROTTLE_AUTH_LIMIT` | `POST /auth/login`, `reset-password`, `unlock/verify` |
| `issue` | 10 | `THROTTLE_ISSUE_LIMIT` | everything that mints a credential or sends mail |
| `money` | 120 | `THROTTLE_MONEY_LIMIT` | `payments/:id/confirm`, `payments/:id/submit` |

Set any limit to `0` to disable that tier.

> **Exactly one throttler is registered, on purpose.** `ThrottlerGuard` loops
> over every throttler in `forRoot()` and applies *all* of them to *every* route
> — registering four named tiers does not let a route pick one, it subjects each
> route to all four, so the tightest silently governs the whole API. The first
> implementation here did register four, and a 3/min tier meant for
> password-reset mail throttled reads, beneficiary activation and payment
> release after three requests. `@ThrottleTier` now overrides the single
> `default` throttler's limit for the route it decorates, so one limit applies to
> any request and it is the one named on the handler.

The `default` tier is high by design: the analyst console polls ~22 req/min while
merely sitting open, before any user action. This tier stops runaway automation,
not ordinary use — the security-relevant caps are `auth` and `issue`.

Storage is in-process by default — correct as shipped, since `docker-compose.yml`
runs exactly one backend container, so the per-process counter *is* the global
counter. Setting `THROTTLE_REDIS_URL` switches it to
`common/redis-throttler-storage.ts` with no other change; do that before running
more than one instance or an attacker gets `limit × replicas` attempts.

`helmet` added in `main.ts` (CSP off — this process serves JSON and the Swagger
UI, which needs inline scripts).

**The recovery limiter was kept, not deleted** as originally suggested. The two
guard different axes and neither subsumes the other: the throttler keys on the
*caller* (one source, many accounts); the recovery map keys on the *target*
(many sources, one account — mail-bombing a specific customer, which every per-IP
limit in the world lets through). The reasoning is recorded in the code.

**Demo posture is now enforced, not just documented.** `OTP_DEMO_MODE` gates both
the fixed `123456` and the short numeric `requestId`; with it off, the code is
`randomInt`-uniform and the requestId is a 128-bit token. `assertSafeConfig()`
runs before the Nest app is created: it logs every active demo affordance as a
warning in development and **throws in production**, covering `OTP_DEMO_MODE`,
`GEO_ALLOW_MOCK_COUNTRY`, `DEMO_TEST_RUNNER`, `GEO_DEV_USE_PUBLIC_IP`,
`AUTH_ALLOW_BEARER`, an insecure cookie, and the default `JWT_SECRET`.

---

## 3. Observability — P1

**Fail-open is no longer silent.** `ScorerHealthService` keeps a rolling window
of the last 50 scoring outcomes. Every fallback is recorded with a reason
(`transport_error` / `unscored` / `disabled`); crossing 20% fallback logs one
`ALERT ... DEGRADED` line on the *edge* (not per request, which would be noise)
and logs recovery on the way back.

Exposed at `GET /api/health/scoring`, which the frontend `ScoringHealthBanner`
polls. When scoring is degraded the analyst sees a banner saying these verdicts
are rules rather than the model — the distinction that is otherwise invisible,
since a heuristic verdict renders identically to a model one. The banner renders
nothing while healthy.

**Request tracing.** `CorrelationIdInterceptor` binds an id to every request,
reusing a caller-supplied `X-Correlation-Id` when present (validated against
`/^[A-Za-z0-9._:-]{8,128}$/` — it ends up in log lines and outbound headers) and
minting a UUID otherwise. It is carried in an `AsyncLocalStorage`, not threaded
as a parameter, because it has to reach `http-scorer.ts` through the `Scorer`
interface, which deliberately knows nothing about HTTP. `HttpScorer` forwards it
to Sentinel, so the model's own logs join the same timeline. The id is echoed on
every response and surfaced in the frontend error boundary.

**Readiness.** `GET /api/health/ready` checks the database and Sentinel and
reports the scoring window. It 503s **only** when the database is down. A
Sentinel outage returns 200 with `status: "degraded"` — fail-open is the designed
behaviour and payments still flow, so pulling the instance out of the load
balancer would turn a degraded system into an outage.

---

## 4. JWT → httpOnly cookies (+ CSRF) — P1

The token was in `localStorage` and attached by hand, so any XSS anywhere meant
token theft and account takeover.

**Shipped.** Login sets an `httpOnly; SameSite; Secure` cookie
(`env.auth.cookieName`, Max-Age derived from `JWT_EXPIRES_IN` so cookie and token
expire together). `jwt.strategy` reads it from there. The frontend store no
longer holds a token at all — only the display profile — and `api.ts` sends
`withCredentials: true` instead of an `Authorization` header. A `POST
/auth/logout` route clears both cookies, because a page that cannot read the
cookie cannot delete it either.

`AUTH_ALLOW_BEARER` keeps header auth working for the Swagger console and the
Playwright API suite, which cannot hold cookies. It defaults on in development,
off in production — otherwise the httpOnly guarantee is decorative — and
`assertSafeConfig()` refuses a production boot with it enabled.

**CSRF.** Cookie auth means the browser now attaches credentials to any request
to this origin, including one triggered from an attacker's page. `SameSite`
blocks most of that but is a single point of failure, so a double-submit token
is layered underneath: login mints a token into a JS-readable cookie, the
frontend echoes it in `X-CSRF-Token`, and `CsrfGuard` compares them in constant
time. A cross-origin page can cause the cookie to be *sent* but cannot *read*
it, so it cannot produce the header.

Exempted, deliberately: `login` (mints the token; nothing to echo yet) and the
recovery controller (reached by a logged-out visitor with no session — there is
no ambient authority to abuse, and every route re-proves identity from the body).

---

## 5. Richer verdict / risk visualization — P1

- **`ShapWaterfall`** renders `explanation.top_features`, which the model was
  already returning and the card was discarding. Bars diverge from a centre axis
  — right/red raises risk, left/green lowers it — because the sign is the point:
  a one-directional chart hides that some features actively vouch for the
  customer. Each row shows the feature, the customer's actual value, and the
  signed SHAP push.
- **`FusionMath`** shows the noisy-OR being built term by term: each watcher's
  calibrated `pᵢ`, its weight, `wᵢ·pᵢ`, and the running product, ending in
  `risk = 1 − Π(1 − wᵢ·pᵢ)`. Weights are mirrored from `ml/config.py`. The
  recomputed total is compared against the model's own `risk_score` and any
  mismatch is stated rather than hidden — a disagreement means a post-fusion
  policy floor fired or the weights have drifted, and both are worth knowing.
- **`GeoPanel`** renders the `country / geoLat / geoLon` the gateway already
  resolves, flags foreign-market requests, and runs a haversine impossible-travel
  check against a previous point. It returns `null` — not `false` — when it
  cannot judge, because "not checked" and "checked and fine" must not look alike.
- **Entity timeline** lives in the correlation panel (below): related events
  plotted oldest-to-newest by score, so escalation reads as a shape.

---

## 6. Real-time analyst console + case correlation — P2

**Live stream.** `LiveAlertsService` (in `fraud/`, so the gateway can publish
without a circular import) is an RxJS Subject the gateway pushes every scored
event to; `@Sse('stream')` on the analyst controller turns it into SSE, with a
25s keep-alive frame so proxies do not drop the idle connection.

This is only authenticatable *because* of §4: `EventSource` cannot set an
`Authorization` header, so a bearer-only API would have forced the JWT into the
query string — into every access log on the path. With the session in a cookie,
`withCredentials: true` just works.

The console's status chip reports the real stream state (`live` /
`connecting` / `reconnecting`) rather than a hardcoded "live" that stays lit
through a dropped connection. Polling is retained as a slower safety net (15s
instead of 4s), because SSE can drop and silently reconnect and a subtly stale
console is worse than an openly polling one.

**Correlation.** `GET /analyst/events/:id/related` finds events sharing the
anchor's user, device fingerprint or IP within a window, and reports *which* link
matched per row — "same device across different customers" is a completely
different story from "same customer retrying", and only the link type
distinguishes them. It matches only on identifiers the anchor actually has,
or a null fingerprint would "match" every other event that is also missing one.
IPs and fingerprints are masked in the response.

**Frontend robustness.**

- `useSingleFlight` guards every money-path action with a **ref**, not a state
  flag. `setBusy(true)` does not take effect until React re-renders, so two
  clicks in the same tick both saw `busy === false` and both fired — precisely
  the duplicate submit §1 exists to absorb. The ref is synchronous and wins that
  race. Applied to initiate/confirm/submit and payment delete.
- `ErrorBoundary` wraps the routed page, keyed on pathname. Without it a render
  error blanks the whole app — in a banking UI that means a user mid-payment
  sees a white screen with no idea whether their money moved. It says no money
  moved as a result, tells the user to check Modify Payments before retrying,
  and shows the correlation id from §3.
- `apiError` now gives actionable text for 429 and CSRF-rejection responses.

---

## Verification

Verified:

- `tsc --noEmit` clean for both apps; `nest build` and `next build` both succeed.
- Backend **boots**: all modules resolve, throttler/CSRF guards and the
  correlation interceptor register, `assertSafeConfig()` prints the expected
  development warnings.
- Migration `20260725120000_ledger_idempotency` **applied**; the unique index
  `ledger_entries_paymentId_direction_key` exists.
- `npm run verify:money-path` passes against the live database — all three §1
  invariants: 1-of-10 concurrent debits wins with the balance correct and never
  negative, repeated hold releases apply exactly once and settle at 0, and a
  duplicate DEBIT row is rejected with `P2002`.
- The clamped release was separately exercised on a scratch account: a short
  hold releases what exists (no strand), a repeat release is a no-op (never
  negative), and six concurrent releases against one hold release exactly the
  held amount in total (no over-release).

Still unexercised at runtime:

- Cookie login, the SSE stream, and the correlation query have not been driven
  end to end.
- The Playwright suite has not been run. Expect fixture updates: login no longer
  returns `accessToken` when `AUTH_ALLOW_BEARER` is off, and state-changing
  requests now require the `X-CSRF-Token` header.

Known data condition in the current dev database, not a code defect: several
payments sit in `HELD` while every account has `holdAmount = 0`. That is
residue from the pre-fix cut-off loop. They are releasable again under the
tolerant release above, and each release logs the shortfall.

A dependency note, since it bit during this work: installing `@nestjs/throttler`
caused npm to hoist `@nestjs/common` and `@nestjs/core` to the workspace root
while leaving their siblings nested. Nest resolves its optional packages relative
to those two, so `platform-express` and `class-validator` silently stopped
resolving. Fixed by passing `ExpressAdapter` explicitly (removing the implicit
lookup entirely) and by pinning `class-validator@0.14.4` at the root so exactly
one copy exists — a version skew there would have split the decorator metadata
registry and silently disabled `whitelist`/`forbidNonWhitelisted` validation. The
community Redis throttler adapter was dropped for the same reason and replaced
with `common/redis-throttler-storage.ts` (~40 lines against `ioredis`, atomic
INCR+PEXPIRE via Lua, fails open when Redis is unreachable).

---

## How the items interlock

Four items were the same underlying concern — *"the same intent applied twice"*:
the TOCTOU ledger race, the `runCutoff` re-release loop, submit idempotency, and
frontend double-submit. All four are now handled by the same two primitives: the
balance/hold mutation is atomic with its own check, and `(paymentId, direction)`
is the idempotency key.

---

*Implemented 2026-07-25. Prior revision corrected the §2 rationale
(per-challenge caps already existed), added the `runCutoff` bug, and dropped two
items already resolved in the tree (the `api.ts` 401 redirect target, and the
`explain=true` scoring flag).*
