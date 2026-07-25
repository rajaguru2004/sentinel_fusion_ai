# Finspar-X — Enhancement Plan (Frontend & Backend)

A working plan for hardening and enriching the bank simulator (NestJS backend +
Next.js frontend) and its integration with the Sentinel Fusion AI scorer. Each
item below is grounded in the current code, with file references, the reason it
matters, and the concrete change.

This is a planning/README document — no behaviour has changed yet.

---

## Baseline — what is already strong

Before the gaps: this is a well-architected app, not a prototype.

- Proper payment flow: `initiate` (NEW draft) -> `confirm` (fraud gateway ->
  decision) -> OTP + transaction password -> `submit` -> ledger post
  (`apps/backend/src/payments/payments.service.ts`).
- The fraud gateway runs **before** the ledger is touched, persists a
  `FraudEvent`, and the HTTP scorer **fails open** to a heuristic so a model
  outage cannot hang the money path
  (`apps/backend/src/fraud/fraud-gateway.service.ts`,
  `apps/backend/src/fraud/http-scorer.ts`).
- Money is `BigInt` paise end to end (no floating-point money), serialised as
  strings on the wire (`apps/backend/src/main.ts`).
- Double-entry ledger inside a Prisma `$transaction`, with hold/release and a
  cut-off cron (`apps/backend/src/ledger/ledger.service.ts`).
- Global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted`
  (`apps/backend/src/main.ts`).
- Credential guessing is already capped **per challenge**: OTP verify counts
  attempts and burns the challenge at `env.otpMaxAttempts`
  (`apps/backend/src/otp/otp.service.ts:69-81`), and login locks the user at
  `env.loginMaxAttempts` (`apps/backend/src/auth/auth.service.ts:130-132`).
- A real explainability surface already renders on the frontend
  (`apps/frontend/components/sentinel/VerdictCard.tsx`).

The enhancements below make it **reliable, secure, and defensible** — not merely
functional.

---

## Priority overview

| # | Enhancement | Layer | Priority | Effort | Risk if skipped |
|---|---|---|---|---|---|
| 1 | Ledger double-spend (TOCTOU) + `runCutoff` hold release + submit idempotency | Backend | **P0** | M | Account overdraw / negative holds / money integrity |
| 2 | Rate limiting + security headers | Backend | **P0** | S | OTP/login brute-force |
| 3 | Observability: fail-open alerting, tracing, health | Full-stack | P1 | M | Silent fraud-scoring outage |
| 4 | JWT -> httpOnly cookies (+ CSRF) | Full-stack | P1 | M/L | XSS -> token theft -> ATO |
| 5 | Richer verdict/risk visualization | Frontend | P1 | M | Weaker analyst trust & demo |
| 6 | Real-time analyst console + case correlation | Full-stack | P2 | L | No live operational surface |

`P0` = do first (money integrity + trivially exploitable). `S/M/L` = small /
medium / large effort.

---

## 1. Ledger double-spend (TOCTOU) — P0

**TOCTOU** = *time-of-check to time-of-use*: the gap between checking a condition
and acting on it. In a ledger that gap is the account balance, and the result is
money created or destroyed.

**Where it is.** `ledger.service.ts` `postPayment` (~lines 39–48):

```ts
const source = await tx.account.findUnique(...)          // CHECK: read balance
const available = source.clearBalance - source.holdAmount
if (available < payment.amount) throw ...                // decide on that read
const newSourceBalance = source.clearBalance - payment.amount
await tx.account.update({ data: { clearBalance: newSourceBalance } })  // USE
```

It reads the balance, decides, then writes `read − amount`. It is inside
`$transaction`, but that alone is **not** sufficient: Postgres' default *Read
Committed* isolation lets two concurrent transactions read the same starting
balance before either writes.

**The race.** Account has ₹100, two ₹60 payments post concurrently:

- T1 reads 100, checks `100 >= 60` OK, writes 40.
- T2 reads 100, checks `100 >= 60` OK, writes 40.
- Both succeed → balance 40, **₹120 left an account holding ₹100**. Overdraw /
  double-spend.

The `holdAmount` path shares the shape; `holdPayment` uses atomic `increment`
(safe for the increment itself), but the read-check-write in `postPayment` is the
exposure.

**Fix — options, best first:**

1. **Atomic conditional decrement (recommended).** One statement that debits only
   if funds suffice:
   `UPDATE account SET clearBalance = clearBalance - :amt
    WHERE id = :id AND clearBalance - holdAmount >= :amt`,
   then check rows-affected (0 = insufficient → reject). Check and use become one
   indivisible operation; no window exists.
2. **Pessimistic lock:** `SELECT … FOR UPDATE` on the account row at the top of
   the transaction (Prisma `$queryRaw`); the second txn blocks until the first
   commits.
3. **Serializable isolation:** `$transaction(fn, { isolationLevel: 'Serializable' })`;
   Postgres aborts one racer, you catch and retry.
4. **Optimistic version column:** `version` on `account`, update
   `WHERE id AND version = n`; 0 rows → retry.

**Do together with idempotency.** `submit()` sets status `PROCESSING`
(`payments.service.ts:225`) then posts. If the ledger throws, the payment is
stranded in `PROCESSING` (neither editable nor submittable) with no compensation.
Make `postPayment` idempotent (guard on status / a unique ledger-entry key) and
add a reconciliation path so a retried submit can neither post twice nor strand.

### 1b. `runCutoff` releases the hold before it posts — same file, no concurrency needed

`ledger.service.ts:131-137` walks the due HELD payments and does:

```ts
await this.prisma.account.update({ ... holdAmount: { decrement: p.amount } })  // release
await this.postPayment(p.id).catch((e) => this.logger.error(e))                // then post
```

The decrement is committed in its own statement, outside `postPayment`'s
`$transaction`, and the post is swallowed by `.catch`. If the post fails the
funds are un-held but the payment **stays `HELD`** (only a successful
`postPayment` writes `COMPLETED`), so the next cron run picks it up and
decrements *again*. Repeated failure drives `holdAmount` negative, silently
inflating `clearBalance - holdAmount` — the very quantity `postPayment` checks
against.

This is arguably more urgent than the race above: it needs no concurrent
traffic, only one failing post, and it compounds on a schedule.

**Fix.** Pull the release inside the posting transaction (decrement the hold and
debit the balance in the same `$transaction`, so a throw rolls both back), and
make the status transition the guard — a payment that is no longer `HELD` must
not be re-released. Same idempotency key as above.

---

## 2. Rate limiting + security headers — P0

**Current.** A bespoke `rateLimit()` exists only in `recovery.service.ts:26`
(forgot-password / unlock). Login, OTP-verify, and payment-confirm have no
request-level limiter.

**What is *not* the gap.** Per-credential guessing is already capped: OTP verify
burns the challenge after `env.otpMaxAttempts` (`otp.service.ts:69-81`) and login
locks the user after `env.loginMaxAttempts` (`auth.service.ts:130-132`). There is
no "6-digit code with unlimited guesses" hole.

**What the gap actually is** — three things the per-challenge caps do not cover:

1. **Request volume.** Nothing caps how many *challenges* an attacker can issue,
   or how fast. The attempt counter resets with every fresh challenge, so the cap
   throttles a single OTP, not the endpoint.
2. **Per-IP / unauthenticated abuse.** The caps are per-user-row; an attacker
   spraying one guess each across many user ids never trips one.
3. **Per-process state.** The `recovery.service.ts` limiter is an in-memory map —
   it resets on restart and is not shared across workers or instances.

**Change.**

- Add `@nestjs/throttler` globally in `app.module`, tighten per-route with
  `@Throttle`: aggressive on `POST /auth/login`, `POST /otp/verify` and the OTP
  *issue* path (e.g. 5/min/IP), moderate on payments, generous on reads. This is
  the layer that stops (1) and (2) above.
- Back the limiter with Redis (already running for Sentinel) so limits hold
  across workers/instances instead of being per-process — fixes (3), and lets the
  `recovery.service.ts` map be deleted in favour of one mechanism.
- Add `helmet` in `main.ts` for security headers (one line).

Cheapest high-value item on the list.

**Say the demo posture out loud.** `otp.service.ts:127` returns a hardcoded
`'123456'`, and `requestId` is a 4–5 digit integer (`otp.service.ts:132`). Both
are deliberate demo affordances and the surrounding logic (bcrypt hash, TTL,
attempt burn) is real — but any claim of a banking security posture has to state
that OTP is currently a fixture, not a secret. Gate both behind the same env flag
so a non-demo boot cannot silently keep them.

---

## 3. Observability — fail-open alerting, tracing, health — P1

**Fail-open is silent.** `http-scorer.ts:60` drops every transaction to the
heuristic on any Sentinel error. Correct for availability, but nothing alerts —
fraud scoring could run on rules for hours unnoticed.

- Emit a metric + log-alert whenever the fallback fires, and surface a "fraud
  scoring degraded" banner on the analyst console.
- Do the same for `degradation.store_unavailable`, currently only `log.warn`.

**Request tracing.** A payment crosses Next.js → NestJS → Python → Redis with no
shared id. Generate a correlation-id at the edge, propagate it as a header through
`http-scorer` into the Sentinel call, and log it everywhere. "Why was this held?"
becomes one traceable timeline — and the backbone of the analyst investigation
view (#6).

**Dependency health.** Add a readiness endpoint that pings the DB and Sentinel
`/health`, so orchestration knows the *money path* is serviceable, not just that
the process booted.

---

## 4. JWT → httpOnly cookies (+ CSRF) — P1

**Current.** The token is in `localStorage` and attached manually
(`apps/frontend/lib/api.ts:11-21`). Any XSS anywhere = token theft = account
takeover — the highest client-side risk in a banking app.

**Change.**

- Backend issues the JWT as an `httpOnly; Secure; SameSite=Strict` cookie on
  login; the browser sends it automatically.
- Frontend stops touching the token (remove the `localStorage` read + manual
  `Authorization` header).
- Update `jwt.strategy` to read the token from the cookie.
- Because you become cookie-based, add **CSRF protection** (double-submit token,
  or `SameSite` + strict origin checks).

Most involved item here (touches auth on both sides) — sequence after the quick
wins, but treat as non-optional for a banking posture.

---

## 5. Richer verdict / risk visualization — P1

**Current.** `VerdictCard.tsx` already shows the risk badge, score, fitted band
scale, plain-language reasons, per-watcher contribution bars, degradation flags,
and raw JSON. Good foundation.

**Available but not shown:** `explanation.top_features` (`lib/sentinel.ts:43`)
carries `{ feature, value, shap }` per feature, but the card only renders text
`reasons`.

**Add:**

- **SHAP feature breakdown** — render `top_features` as a signed bar / waterfall
  (feature name, the customer's actual value, its push toward/away from risk).
  Turns "why" into a quantified, defensible explanation.
- **Fusion math made visible** — show each calibrated `p_i`, its weight, and how
  the noisy-OR composes them into `risk_score`, so the "Command Center" metaphor
  is backed by the actual arithmetic.
- **Entity timeline** — a sparkline of this user's / device's recent events and
  scores (from persisted `FraudEvent`), so a verdict reads in context. On-ramp to
  the correlation view (#6).
- **Geo** — `country / geoLat / geoLon` are already resolved
  (`fraud-gateway.service.ts`); a map pin or "impossible travel" flag on logins is
  cheap and striking.

---

## 6. Real-time analyst console + case correlation — P2

**Real-time console.** You have `app/(app)/analyst/page.tsx`, a `Case` model, and
`FraudEvent` rows written on every assess. Move from request/response to a live
**SSE stream** (NestJS endpoint returning an event-stream; frontend `EventSource`)
so HELD / BLOCKED cases appear the instant `confirm()` produces them.

**Case correlation view.** `FraudEvent` is keyed by `userId`,
`deviceFingerprint`, `ip`. On a case, query "other events sharing this
user / device / IP within a window" and render them as a linked cluster — the
correlation story made concrete with data you already store, and the visible seed
of a future entity-graph.

**Frontend robustness (do alongside):**

- Add error boundaries and consistent loading / optimistic states on the payment
  and beneficiary forms.
- **Disable double-submit** on confirm/submit — a double-click is exactly the
  retry that the idempotency + TOCTOU gaps (#1) mishandle.

---

## How the items interlock

Four items are the same underlying concern — *"the same intent applied twice"*:
the **TOCTOU ledger race** (#1), the **`runCutoff` re-release loop** (#1b),
**submit idempotency** (#1), and **frontend double-submit prevention** (#6). All
four are fixed by the same two primitives: make the balance/hold mutation atomic
with its own check, and make the payment's status transition the idempotency
guard. Fix them together.

## Suggested sequence

1. **Money-path safety** — the `runCutoff` hold-release bug (#1b) first, since it
   is a plain sequencing error with no concurrency prerequisite; then TOCTOU
   atomic debit + submit idempotency + double-submit guard (#1, part of #6).
2. **Rate limiting + helmet** (#2) — a day, high value, low risk.
3. **Observability** — fail-open alerting + tracing + health (#3).
4. **Cookie auth + CSRF** (#4).
5. **Visualization + real-time analyst console** (#5, #6).

Items 2 and 3 are small, high-value, and low-risk — knock them out before the
larger cookie/ledger/console work.

---

*Generated as a planning reference. File references point at the current tree;
line numbers are approximate and may drift as the code changes.*

*Revised 2026-07-25 after a re-read against the code: corrected the §2 rationale
(per-challenge attempt caps already exist — the gap is request-volume, per-IP and
cross-process limiting), added the `runCutoff` hold-release bug as §1b, and
dropped two items that were already resolved in the tree (the `api.ts` 401
redirect — `app/login/page.tsx` exists, so the target is correct; and the
`explain=true` scoring fix — `http-scorer.ts:37` already posts
`/score?explain=true`).*
