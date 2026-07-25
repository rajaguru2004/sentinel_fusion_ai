# Sentinel demo — end-to-end walkthrough

Everything built to make all four Sentinel watchers demonstrable inside FinSpark,
and to prove on demand that they still work: the **Sentinel Console** screens,
the **login-page test runner**, and the **Playwright suite**.

`DEMO_PRESENTATION.md` is the stage script — what to say. This is the machinery —
what exists, why it is shaped this way, how to run it, and what the models
actually do when you ask them.

> **Before you present, read §7.** Three of the four watchers do not behave the
> way `DEMO_PRESENTATION.md` describes. Every claim below was measured against
> the running model, not inferred from the code.

---

## 1. The problem this solves

`DEMO_PRESENTATION.md` promises a jury four watchers plus a fusion Command
Center. Two of them already had a stage: the bank naturally produces payments and
logins, so **Money** and **Habits** ride the real banking screens.

The other two had nothing. The bank's fraud adapter only ever emits two domains —
`financial` for anything money-shaped, `behaviour` for a login
([sentinel-adapter.ts:109](../apps/backend/src/fraud/sentinel-adapter.ts#L109)):

```ts
const domain: Domain = e.eventType === 'LOGIN' ? 'behaviour' : 'financial';
```

A bank emits no raw network packets and no TLS certificate inventory, so **no
banking action can ever produce a `cyber` or `quantum` event**. Those two
watchers, and the Command Center's fusion view, could only be shown by curling
the model from a terminal — which is honest but reads as a different product.

And §11 of the demo doc specified a Playwright suite that was never built: no
`playwright.config.*`, no test directory, and a dead `"test": "jest"` script in
the backend with no config and no tests.

So there were three gaps:

1. Watchers 3, 4 and the Command Center had no UI.
2. There was no way to prove the demo still worked without walking it by hand.
3. Nothing verified that the demo was even talking to the ML model rather than
   the Phase-1 heuristic fallback.

---

## 2. What was built

| Area | Path | Purpose |
|---|---|---|
| Model proxy | [apps/backend/src/sentinel/](../apps/backend/src/sentinel/) | `POST /api/sentinel/score`, `GET /api/sentinel/ready`, `GET /api/sentinel/metrics` — lets the **browser** reach the model |
| Test runner | [apps/backend/src/demo-tests/](../apps/backend/src/demo-tests/) | `POST /run`, SSE `GET /stream/:runId`, `/status`, `/cancel`, `/specs`. Spawns Playwright. Only mounts when `DEMO_TEST_RUNNER=true` |
| Sentinel Console | [apps/frontend/app/(app)/sentinel/page.tsx](../apps/frontend/app/(app)/sentinel/page.tsx) | One page, three tabs: Intrusion, Future-Proofing, Command Center |
| Verdict card | [apps/frontend/components/sentinel/VerdictCard.tsx](../apps/frontend/components/sentinel/VerdictCard.tsx) | Risk badge, score, fitted band edges, reasons, per-watcher contribution bars, raw JSON |
| Presets & bands | [apps/frontend/lib/sentinel.ts](../apps/frontend/lib/sentinel.ts) | Scenario presets, response types, the band edges rendered in the UI |
| Runner panel | [apps/frontend/components/demo/DemoTestPanel.tsx](../apps/frontend/components/demo/DemoTestPanel.tsx) | The buttons on `/login`, with a live streaming log |
| Playwright suite | [playwright.config.ts](../playwright.config.ts), [tests/](../tests/) | 7 spec files, 38 tests, at the **simulator root** — not a separate workspace |
| Env helper | [scripts/print-demo-env.js](../scripts/print-demo-env.js) | `npm run e2e:env` prints the exact export block the backend needs |

Three existing files changed:

- [apps/frontend/lib/nav.ts](../apps/frontend/lib/nav.ts) — one new sidebar entry.
- [apps/frontend/app/login/page.tsx](../apps/frontend/app/login/page.tsx) — renders the runner panel.
- [apps/frontend/app/(app)/layout.tsx](../apps/frontend/app/(app)/layout.tsx) — **bug fix**, §8.

Plus root `package.json` (Playwright dev-deps and `e2e:*` scripts), `tsconfig.json`
for the suite, `.gitignore`, and `.env.example` documentation.

---

## 3. Design decisions, and why

### 3.1 Why a proxy instead of calling the model from the browser

The FastAPI service mounts **no CORS middleware** — there is no
`add_middleware(CORSMiddleware, …)` anywhere in `sentinel_fusion_ai/service`. A
`fetch('http://localhost:8000/score')` from the Next.js app is blocked by the
browser before it ever leaves the tab. Adding CORS to the model would also mean
shipping the model's API key to the client.

So the console posts to `/api/sentinel/score` on the bank's own origin, and the
bank forwards it with the key attached.

Two deliberate properties of that proxy:

- **It does not go through `FraudGateway`.** The console is an inspection tool,
  not a money path. Nothing it does writes a `FraudEvent`, touches the ledger, or
  pollutes the analyst feed.
- **It passes the model's errors through verbatim.** `EventIn` is
  `extra="forbid"`, so a stray field is a 422 naming the offending key — exactly
  what someone editing the console form needs to see, rather than a generic
  "something went wrong".

It also uses a 30s timeout rather than `SENTINEL_TIMEOUT_MS` (default 800ms).
That budget exists because the money path must never hang; the console has no
such constraint, and a cold SHAP call takes ~6s. Timing out there would show the
jury a spurious error.

### 3.2 Why the console is one page with tabs

Considered three separate routes and a single stacked page. Tabs won: one sidebar
entry, one place to point the jury, and each tab stays focused on one watcher
while the Command Center tab does the fan-out. Fewer nav items also keeps the
banking IA recognisable, which matters — the whole point is that this is a bank
with AI in it, not an AI demo with a bank attached.

### 3.3 Why the test runner is flag-gated with an allowlist

The buttons sit on `/login`, which is pre-auth, and `EventSource` cannot send an
`Authorization` header. So the runner endpoints are unauthenticated. That is only
acceptable because of four hard constraints, all enforced in
[demo-tests.service.ts](../apps/backend/src/demo-tests/demo-tests.service.ts):

1. The module only registers when `DEMO_TEST_RUNNER=true`. With the flag off the
   routes **404** — they do not exist, rather than existing and refusing.
2. `spec` is looked up in a fixed `SPEC_MAP`. Anything else is a `400` before any
   process is spawned.
3. `execFile` with an **argv array** and `shell: false`. There is no shell, so no
   metacharacter in any input can be interpreted.
4. A single-run mutex (`409` on a second run), a 5-minute wall-clock kill, and a
   bounded in-memory log.

Verified rejections: `../../etc/passwd`, `money; rm -rf /`, `""`, `all2`.

**Never enable `DEMO_TEST_RUNNER` outside a demo machine.**

### 3.4 Why headless, not a visible browser

A server-launched headed Chromium needs a display, which fails on a headless
box or container, and a window stealing focus mid-presentation is a real risk.
Headless plus a streamed log is reliable everywhere, and the UI specs still drive
the actual bank in a real browser — Playwright also records a video and trace per
failure, which doubles as demo backup material.

### 3.5 Why the suite lives at the simulator root

The task was explicit: in the bank simulator, not another workspace. The suite
spans three processes (Next, Nest, the Python model), so it belongs to neither
app; the simulator root is already a package, so `tests/` plus a root
`playwright.config.ts` adds no workspace and no new dependency graph.

---

## 4. Running it

### 4.1 Bring the stack up

```bash
cd Finspar-X-Bank-Simulator

npm install
npx playwright install chromium

npm run up                                # postgres, host port 5433
npm run db:migrate
npm run db:seed

docker start sentinel_fusion_ai-api-1     # or: cd ../sentinel_fusion_ai && docker compose up -d
curl http://localhost:8000/ready          # -> {"ready":true,...}
```

### 4.2 The backend environment — the part that actually bites

**`apps/backend` has no dotenv loader.** No `ConfigModule`, no `dotenv` import;
[common/env.ts](../apps/backend/src/common/env.ts) reads `process.env` directly.
Writing `apps/backend/.env` does **not** reliably reach the code that chooses the
scorer — Prisma happens to side-load that file for `DATABASE_URL`, but its
ordering against `FraudModule`'s provider factory is not guaranteed.

Export them instead:

```bash
eval "$(npm run --silent e2e:env)"
npm run dev:backend:demo        # tees stdout to .artifacts/backend.log
```

`npm run e2e:env` prints this, with the reasoning inline:

| var | default | must be | why |
|---|---|---|---|
| `SENTINEL_ENABLED` | `false` | `true` | false binds the Phase-1 `HeuristicScorer`; the ML model is never called |
| `SENTINEL_URL` | `host.docker.internal:8000` | `http://127.0.0.1:8000` | host-run Node resolves `localhost` to IPv6 and times out |
| `SENTINEL_TIMEOUT_MS` | `800` | `15000` | the cold SHAP call takes ~6s; on timeout `HttpScorer` **silently** falls back to the heuristic |
| `GEO_ALLOW_MOCK_COUNTRY` | `false` | `true` | false makes the login page's mock-VPN selector a no-op |
| `OTP_TTL_SECONDS` | `100` | `900` | the hold → release → authorize flow outlives 100s |
| `JWT_EXPIRES_IN` | `15m` | `60m` | long UI specs outlive 15m |
| `DEMO_TEST_RUNNER` | `false` | `true` | mounts the login-page runner routes |

Confirm it took:

```
[FraudModule] SCORER -> Sentinel HttpScorer (http://127.0.0.1:8000)
```

If it says `SCORER -> HeuristicScorer (Phase 1)`, the demo is not using the model.

`dev:backend:demo` tees to `.artifacts/backend.log`. That log is **not cosmetic** —
the suite reads it to prove the model was really called (§6.2).

### 4.3 Frontend

```bash
NEXT_PUBLIC_DEMO_TEST_RUNNER=true npm run dev:frontend
```

Without that variable the login page renders normally with no panel. The panel
also hides itself when the backend runner is not mounted, so the two flags can
never visibly disagree.

---

## 5. The three surfaces

### 5.1 Sentinel Console — `/sentinel`

Sidebar → **Sentinel Console**. A health chip in the header mirrors the model's
`/ready`. Each tab has a scenario preset, editable fields, a Send button and a
verdict card.

**Intrusion Watcher.** Send a network event directly. Preset: `db-server-07`
ships 9 MB out to port 4444 in a 1.2s burst — textbook exfiltration → `CRITICAL`,
`p_cyber = 1.0000`. Every field is editable, so a judge can change the port or
the byte counts and re-send.

**Future-Proofing Watcher.** Send a certificate inventory record. Preset 1:
`secret` data behind RSA-2048 on a 3650-day certificate → `CRITICAL` (0.9000).
Preset 2: the same certificate protecting `internal` data → `LOW` (0.0000). That
second preset is the contrast beat that genuinely works — see §7.3 for why it is
*not* the one the demo doc describes.

**Command Center.** Fires one event at each of the four watchers in sequence and
shows four cards side by side: the fused level, the score, and which single
`contributions.p_*` key lit up. Below them, live `sentinel_scored_total` counters
scraped from the model's own `/metrics` — the one number on screen the UI cannot
fake, because it is incremented inside the model's scoring path.

Every verdict card prints the **fitted band edges** for that model, e.g.

> Band edges for `cyber`: medium ≥ 0.0069, high ≥ 0.1559, critical ≥ 0.1837 — this score is 1.0000.

so a verdict reads as a documented threshold rather than a magic number. This is
also what makes the demo doc's "why 0.044 is high" talking point land.

### 5.2 Demo test runner — the panel on `/login`

Five buttons (Money, Habits, Intrusion, Future-Proofing, Command Center) plus
**Test all scripts**. Clicking one:

```
POST /api/demo-tests/run  {"spec":"quantum"}   -> {"runId":"…"}
GET  /api/demo-tests/stream/:runId  (SSE)      -> {type:"line",…} … {type:"done",…}
```

The panel appends each line to a scrolling monospace log, shows a spinner while
running, then a pass/fail badge and a duration. A Cancel button appears during a
run. Buttons disable while a run is active, mirroring the server-side mutex.

A note for maintainers, also in the component: specs 01 and 02 drive this very
login page. That is harmless — nothing auto-runs, and the login form is selected
by `name`/label so the extra markup cannot break them.

### 5.3 The Playwright suite

```
playwright.config.ts
tests/
  global-setup.ts
  helpers/  env  api  sentinel  ui  ids  model-guard  backend-log  fixtures
  specs/
    01-money-watcher.spec.ts      [ui]   drain -> BLOCKED; governance -> HELD -> release -> send
    02-habits-watcher.spec.ts     [ui]   mock-VPN country reaches the model; login scored not blocked
    03-intrusion-watcher.spec.ts  [api]  cyber -> critical, plus contract guards
    04-quantum-watcher.spec.ts    [api]  quantum critical/low, plus the real lever
    05-command-center.spec.ts     [api]  routing, envelope, calibration ordering
    06-sentinel-console.spec.ts   [ui]   the console screens themselves
    07-demo-runner-panel.spec.ts  [ui]   the panel and the runner allowlist
```

Two projects. `api` launches no browser at all and talks only to the model, so it
runs with nothing else up. `ui` is chromium against `localhost:3000`.

```bash
npm run e2e          # everything          -> 36 passed, 2 skipped
npm run e2e:api      # model only          -> 20 passed, 1 skipped
npm run e2e:ui       # browser specs
npm run e2e:demo     # only the @demo-tagged stage beats
npm run e2e:warm     # keep the model's feature store (see §6.3)
npm run e2e:report   # open the HTML report
```

`workers: 1`, `fullyParallel: false` — the specs share one seeded customer, the
ledger, a `SELECT count + 1` refNo generator and the model's per-entity feature
store. `retries: 0` for the stateful UI specs; the stateless API specs opt back
in per file.

---

## 6. How the suite avoids lying to you

A green test run is worthless if the thing under test was quietly replaced. Three
mechanisms exist specifically to prevent that.

### 6.1 Preflight that fails loudly

[global-setup.ts](../tests/global-setup.ts) checks, in order: the model's
`/ready`; a double SHAP warm-up (reporting how long a *warm* call takes, since
that number must stay well under `SENTINEL_TIMEOUT_MS`); the backend's
`/api/health` including `db: "up"`; the frontend; then reseeds and resets state.

Every failure names the command that fixes it. For example, pointing the suite at
a dead model:

```
======================================================================
  E2E PREFLIGHT FAILED
  The Sentinel model service is unreachable at http://127.0.0.1:9999.
======================================================================
  -> cd ../sentinel_fusion_ai && docker compose up -d
  -> docker start sentinel_fusion_ai-api-1
  -> curl http://127.0.0.1:9999/ready    # expect {"ready":true,...}
  -> Use 127.0.0.1, not localhost — Node resolves localhost to ::1 and times out.
```

### 6.2 The fail-open trap, and how it is caught

[http-scorer.ts](../apps/backend/src/fraud/http-scorer.ts) catches **every**
error — timeout, connection refused, `scored:false` — and returns
`HeuristicScorer` output instead. From outside, a HELD payment produced by the
heuristic's beneficiary-age rule is indistinguishable from one produced by
XGBoost: same status, same `riskLevel: HIGH`, same shape. Both make the demo look
like it worked. And `modelScores` is persisted on `FraudEvent` but **not exposed**
by `/api/analyst/feed`, so the detection has to be behavioural.

Four signals, in [model-guard.ts](../tests/helpers/model-guard.ts) and
[backend-log.ts](../tests/helpers/backend-log.ts):

1. **Reason-signature blocklist.** The heuristic's reason strings are literals
   (`No anomalies detected`, `Amount N× the account average`, `High-value
   transfer (₹…`, `Beneficiary activated N min ago`, …) and share no wording with
   the model's. A match fails the test with a diagnosis.
2. **Exact model-call counting.** `HttpScorer` logs one
   `[Sentinel /score] <TYPE> (<id>) country=<c> ->` line per successful call.
   `expectModelCalls(n, fn)` counts those lines around an action. `n = 1` proves
   the confirm reached the model; **`n = 0` proves the released payment did not
   re-score**, which is the `reviewApproved` short-circuit.
3. **Auto-use log fixture.** Fails any test during which the backend logged
   `failing open to heuristic` or `returned scored=false`. This is the only layer
   that catches a *timeout* — the case where the model was reached but answered
   too slowly.
4. **Band decoupling.** The heuristic derives its level from its score via
   `bandOf()`, so it can never emit `HIGH` below 0.25. The model's fitted bands do
   exactly that (`fraud_payment` high starts at 0.0396), so that combination is
   positive proof.

**Verified.** Restarting the backend with `SENTINEL_ENABLED=false` and running
the suite produces:

```
  E2E PREFLIGHT FAILED
  The backend did NOT call the Sentinel model when scoring a login.
  -> SENTINEL_ENABLED defaults to FALSE -> the HeuristicScorer answers, not the ML model.
  -> ...
  -> There is NO dotenv loader — export these: eval "$(npm run --silent e2e:env)"
```

The suite refuses to run rather than passing green on the wrong scorer.

#### Why not the model's own metrics counter

The obvious detector is `sentinel_scored_total` from `/metrics` — unauthenticated
and incremented inside the model. It was the first implementation, and it is
wrong: the service runs `uvicorn --workers 2`, and `prometheus_client` counters
are per-process and in-memory. Consecutive scrapes land on different workers:

```
poll 1: 7 counter rows     poll 4: 0
poll 2: 0                  poll 5: 0
poll 3: 0                  poll 6: 0
```

A "the counter did not move" assertion would fail about half the time for reasons
unrelated to the bank. It survives as a **positive-only** signal — a rise proves
the model was called — and on the Command Center tab, where a rising number is
exactly the point. The exact counting is done from the backend log, which is
single-process.

### 6.3 Determinism

| risk | handling |
|---|---|
| The behaviour model **learns** — once NL is seen for a user it is never "new" again | `global-setup` runs `redis-cli FLUSHALL` against the model's store **by default**; opt out with `E2E_KEEP_FEATURE_STORE=1` |
| `prisma:seed` uses `upsert(update: {})`, so a `SUSPENDED` customer, a locked account or a changed password survive reseeding | explicit `UPDATE customers SET status='ACTIVE'` in preflight; the authorizer password is resolved at runtime from a short candidate list |
| `custRefNo` and beneficiary `code` are unique per customer, and the service's dup-check excludes soft-deleted rows so a reuse is a raw P2002 | `uniqueSuffix()` on both |
| NEFT/RTGS after 19:30, or over ₹25,00,000, return `HELD_CUTOFF` and would mask a fraud hold | every spec pays over **IMPS**, which is exempt; and the UI assertion distinguishes `Funds held for analyst review` from `Funds held — <reason>` |
| `/analyst` polls at 4s/8s so the network never goes idle | auto-retrying assertions, never `networkidle` there; `expect.timeout: 20s` |
| Pages that fetch once re-render and detach header buttons mid-click | `gotoSettled()` waits for networkidle on those (non-polling) screens only |

Run the suite twice back to back — it passes both times.

---

## 7. ⚠️ What the models actually do

All measured against the running bundle (`model_version: dev`,
`contract_hash: ec65b4e5353c0928`). Band edges read from
`models/fusion_engine.joblib` → `FusionEngine.bands`:

| model | low < | medium < | high < | critical ≥ |
|---|---|---|---|---|
| `fraud_payment` | 0.0138 | 0.0396 | 0.2430 | 0.2430 |
| `fraud_application` | 0.0922 | 0.2760 | 0.6471 | 0.6471 |
| `cyber` | 0.0069 | 0.1559 | 0.1837 | 0.1837 |
| `behaviour` | 0.0574 | 0.1148 | 0.4074 | 0.4074 |
| `quantum` | *no fitted bands — falls back to 0.25 / 0.50 / 0.75* |

These are fitted at cost-optimal thresholds, not the round constants, which is
what makes a `fraud_payment` score of 0.044 genuinely "high". **Assert on the
band, never on the raw number** — a retrain moves every edge.

### 7.1 ✅ Money Watcher — works, but the doc's two beats are different scenarios

It discriminates properly and returns the plain-language reasons the demo doc
quotes ("beneficiary was added 2 minutes ago", "first ever payment to this
beneficiary", "amount is 8x this customer's normal spend").

But:

```
brand-new payee, first ever payment    -> CRITICAL -> BLOCKED (account frozen, case opened)
established payee, off-pattern amount  -> HIGH     -> HELD    (analyst queue)
```

§6.3 step 7 says the drain lands on HELD and is then released by an authorizer.
It does not. Swept through the real bank flow, a payee added minutes ago returned
critical at every amount:

```
amount=250000  outcome=BLOCKED  level=CRITICAL  score=0.2429906576871872
amount=150000  outcome=BLOCKED  level=CRITICAL  score=0.2429906576871872
amount=100000  outcome=BLOCKED  level=CRITICAL  score=0.6329113245010376
amount= 50000  outcome=BLOCKED  level=CRITICAL  score=0.6250000000000000
amount= 25000  outcome=BLOCKED  level=CRITICAL  score=0.6329113841056824
```

Two things worth noticing. Smaller amounts score *higher* — the new-counterparty
signal dominates, not the value. And the doc's exact demo amount, ₹2,50,000,
scores `0.2429906576871872` against a critical edge of `0.242990642786026` — over
by **1.5e-8**. The headline outcome sits precisely on the boundary.

With a payee activated days earlier, the same flow lands where the doc expects:

```
amount=  5000  outcome=HELD  level=HIGH  score=0.16671407222747803
amount= 25000  outcome=HELD  level=HIGH  score=0.09090909361839294
amount=100000  outcome=HELD  level=HIGH  score=0.09090909361839294
```

**On stage:** present the drain as the *"no money moved, account frozen, case
opened"* beat — arguably stronger than a hold. Then use an **established payee**
for the governance beat: HELD → maker gets 403 → authorizer releases → Authorize
& Send → COMPLETED, with no re-score. Both are covered by
[01-money-watcher.spec.ts](../tests/specs/01-money-watcher.spec.ts).

### 7.2 🔴 Intrusion Watcher — saturated, effectively always critical

§8.4 promises that re-running with `bytes_out: 2000, dst_port: 443` returns
**low**, proving learned judgement rather than a port blocklist. Measured:

```
benign 1200B in / 800B out, ports 443/80/22/53/8080/4444  -> 0.9961 critical (identical for all)
dns udp/53, tiny payload                                  -> 1.0000 critical
ssh login, zero bytes                                     -> 1.0000 critical
minimal event, no network fields at all                   -> 0.1640 high
```

Not a cold-start artifact: after warming a host with 12 benign `/ingest` events
until `degradation: {degraded:false, user_history:false}`, the benign score was
still `0.9961 critical`. "Low" requires `risk_score < 0.0069`; nothing produced
it.

**On stage:** show the malicious event only. If a judge asks for the benign
re-run, say plainly that this head is currently over-sensitive and point at the
Future-Proofing tab for a contrast that works. The console carries this warning
inline, so nobody is caught out mid-demo. The spec asserts the critical verdict
and keeps the contrast as a visible `test.fixme` rather than deleting it.

### 7.3 🔴 Future-Proofing Watcher — only `q_data_class` moves the needle

§9.4 describes *data sensitivity × algorithm weakness × certificate lifetime*,
and says `q_cert_key_type: "Kyber", q_cert_validity_days: 90` returns **low**.
The full matrix — algorithm and validity have **zero** effect:

```
RSA-2048 / internal / 90d    -> 0.0000 low       Kyber / internal / 90d    -> 0.0000 low
RSA-2048 / internal / 3650d  -> 0.0000 low       Kyber / internal / 3650d  -> 0.0000 low
RSA-2048 / secret   / 90d    -> 0.9000 critical  Kyber / secret   / 90d    -> 0.9000 critical
RSA-2048 / secret   / 3650d  -> 0.9000 critical  Kyber / secret   / 3650d  -> 0.9000 critical
```

Output is binary on the data classification: `public`/`internal` → 0.0,
`confidential`/`secret` → 0.9. **Rotating to post-quantum crypto does not lower
the score.**

**On stage:** the contrast beat is real, but flip **`q_data_class`** (secret →
internal), which is what the console's second preset does. Do not flip the
algorithm and claim it helped. [04-quantum-watcher.spec.ts](../tests/specs/04-quantum-watcher.spec.ts)
asserts the working contrast *and* pins the fact that algorithm and lifetime do
nothing — so a retrain that fixes this fails the test and tells you the story can
be told properly again.

### 7.4 🔴 Habits Watcher — the country has no effect on the score

§7 claims a login from a new country seconds after a domestic one scores HIGH on
impossible travel, with the reason "unusual new country for this customer".

Controlled experiment: feature store flushed, two fresh users, each given one
prior IN login, then a second login one second later.

```
run 1:  user A  2nd login IN -> 0.345132     user B  2nd login NL -> 0.188230
run 2:  user A  2nd login NL -> 0.345132     user B  2nd login IN -> 0.345132
```

Identical inputs bar the country produce identical scores, and across runs the
*foreign* login scored lower as often as higher. The variation tracks
`f_user_secs_since_last` — sub-second differences in when the event was sent —
not `f_user_new_country`, which never appeared in the top SHAP features. The top
attributions for the NL login were:

```
duration_s              value=null    shap=-0.7988
f_user_secs_since_last  value=1.099   shap= 0.5195
f_user_seq_no           value=14      shap= 0.1717
```

`explanation.reasons` came back **empty** for every established user. And with 60
logins of history, a perfectly normal home login also scores `high` (0.1882),
because the behaviour head's high band starts at 0.1148 — so "the NL login is
HIGH" would pass even with the mock VPN entirely broken.

**On stage:** demo it as *"the login is scored and recorded in real time, and
where it came from is part of that score"* — true, and visible in the analyst
feed. Do not promise that the foreign login scores higher.
[02-habits-watcher.spec.ts](../tests/specs/02-habits-watcher.spec.ts) asserts the
plumbing that can actually break — the mock country survives the browser, the
axios interceptor, the fraud gateway and reaches the model as `country=NL`, and
the login is scored rather than blocked — and keeps the country-raises-risk claim
as a documented `test.fixme`.

---

## 8. Bugs found and fixed along the way

**Auth guard raced zustand rehydration.**
[app/(app)/layout.tsx](../apps/frontend/app/(app)/layout.tsx) ran its redirect on
the first client render, before the `persist` middleware had read
`localStorage`. `token` was still `null`, so it bounced to `/login`. In-app
navigation hid this completely — the store is already in memory — but **any full
page load (a deep link, F5, a shared URL, or Playwright's `page.goto`) threw away
a perfectly valid session.** The guard now waits for `persist.hasHydrated()`.

**The suite's own first fail-open detector was unsound.** Described in §6.2 — the
model's metrics counter is per-worker across `--workers 2`. Replaced with
backend-log counting before it could give false confidence.

**Session shape mismatch.** `POST /api/auth/login` returns `{accessToken, user}`;
the test helper read `.token`, silently produced `Bearer undefined`, and every
downstream call 401'd with a misleading "Unauthorized". `apiLogin` now normalises.

---

## 9. Verifying end to end

```bash
# 1. everything
npm run e2e
#    -> 36 passed, 2 skipped
#    The 2 skips are the deliberate fixmes in §7.2 and §7.4.

# 2. model only — needs no bank, no database, no frontend
npm run e2e:api
#    -> 20 passed, 1 skipped
```

**3. The console, by hand.** `/sentinel`:

| tab | action | expected |
|---|---|---|
| Intrusion | Send | `CRITICAL`, `p_cyber = 1.0000` |
| Future-Proofing | Send | `CRITICAL`, 0.9000 |
| Future-Proofing | switch preset to *Low-sensitivity service*, Send | `LOW`, 0.0000 |
| Command Center | Fire one event at each watcher | four cards, one contribution each; counters rise |

**4. The runner, by hand.** `/login` → *Future-Proofing Watcher* → lines stream,
ends `PASSED in ~5s`. Click a second button mid-run → `409`, buttons disabled.

**5. Prove the guards work.**

```bash
# model unreachable -> preflight aborts with fixes
E2E_SENTINEL_URL=http://127.0.0.1:9999 npx playwright test tests/specs/04-quantum-watcher.spec.ts

# model disabled -> suite refuses to run rather than testing the heuristic
#   restart the backend with SENTINEL_ENABLED=false, then:
npx playwright test tests/specs/01-money-watcher.spec.ts

# runner off by default -> routes do not exist
#   restart the backend without DEMO_TEST_RUNNER=true, then:
curl -i http://localhost:3001/api/demo-tests/specs        # -> 404
```

**6. Determinism.** Run `npm run e2e` twice in a row; both pass.

---

## 10. Corrections to `DEMO_PRESENTATION.md`

Ordered by how badly each one breaks a demo or an automation attempt.

1. **§6.3 step 7** — the drain's outcome is **BLOCKED**, not HELD, and the
   account is frozen with an `AI_FLAGGED` case (§7.1). The release/governance
   beat needs an established payee.
2. **§6.5 step 12** — "Go to Payments, open the payment, Authorize & Send". No
   such route. It is `/payments/modify`; **nothing loads until `Search` is
   clicked**; the action is an icon-only button (`title="Authorize & Send"`),
   disabled unless the status is `NEW`/`PENDING_AUTH`/`HELD`.
3. **§8.4 and §9.4** — both contrast beats are wrong as written (§7.2, §7.3).
4. **§7.3 step 5** — the reason "unusual new country for this customer" does not
   appear; reasons come back empty for established users (§7.4).
5. **§6.3 step 6** — "Rail IMPS" is not a field on the payment form. The rail is
   a mode-gate screen rendered *before* the form, and the IMPS card's accessible
   name is `IMPS IMPS` (label + rail badge), so an exact-name match misses it.
6. **§4** — PRIYA_A's password is `Finspark@123` in `prisma/seed.ts`, not
   `NewPass@999`. The seed's `upsert(update: {})` means a password changed
   through the UI survives every reseed, so both can be true on different
   machines; the suite resolves it at runtime.
7. **§11** — "assert the toast contains `HELD`". The UI never renders that
   string. A fraud hold reads `Funds held for analyst review`; a cut-off hold
   reads `Funds held — <reason>`. The em-dash is the discriminator, and asserting
   both directions is what stops a cut-off masquerading as a fraud hold.
8. **§3** — putting the Sentinel variables in `apps/backend/.env` is not enough;
   there is no dotenv loader. Export them (§4.2).
9. **§6.4 / §8.3 / §9.3** — the quoted scores (`0.044`, `1.0`, `0.9`) are bound to
   `model_version` and the bundle's `contract_hash`. §6.4's own guidance is
   right: `risk_level` is authoritative, not the number. The suite asserts levels
   and orderings only.
10. **§11 spec layout** — implemented at `tests/specs/` in the simulator root
    rather than `tests/demo/`, with a `@demo` tag selecting the stage-ready
    subset, since 03–05 are contract tests as much as demo replays.

---

## 11. Known gaps

- **Cyber head is unusable as a discriminator** (§7.2). Needs retraining or
  recalibration before the "learned, not hard-coded" claim can be made about it.
- **Quantum head ignores algorithm and certificate lifetime** (§7.3). The demo
  narrative is about all three factors; the model only sees one.
- **Behaviour head ignores country** (§7.4), and its high band is low enough that
  ordinary logins are flagged.
- **The model's feature store is flushed wholesale** before a run. Fine for a
  demo box; a per-user reset would be better if this ever runs anywhere shared.
- **`Customer.status = 'SUSPENDED'`** is written by the BLOCK path but never read
  anywhere in the codebase, so the freeze is currently cosmetic.
- Node here is v20.19.6 while the root `package.json` previously declared
  `"engines": { "node": ">=24" }`. Playwright and Next 16 run fine on 20, so the
  declaration was relaxed to `>=20`; worth reconciling deliberately.
