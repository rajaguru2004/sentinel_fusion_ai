# Demo Mode — Enable & Run Runbook (Windows)

How to switch the FinSpark simulator into **demo mode** and run the Playwright
demo scripts yourself. Written for **Windows** (Git Bash recommended; PowerShell
notes inline).

> **Two truths to keep in mind on Windows:**
> 1. The backend has **no dotenv loader** — demo env vars must be **exported**,
>    not just left in `.env`, or scoring silently falls back to the heuristic.
> 2. The **login-page panel now works on Windows** and is scoped to a single
>    **Money Watcher** button (login → payment, scored by the live model). The
>    runner was fixed to launch Playwright via `node`, not `npx`. You can still
>    run any spec from the terminal with `npm run e2e*` (commands below).

---

## 0. What "demo mode" turns on

| Flag | Effect |
|---|---|
| `SENTINEL_ENABLED=true` + `SENTINEL_URL=http://127.0.0.1:8000` | Scoring goes to the **ML model**, not the Phase-1 heuristic |
| `SENTINEL_TIMEOUT_MS=15000` | Survives the ~6s cold SHAP call (else it times out → heuristic) |
| `GEO_ALLOW_MOCK_COUNTRY=true` | The login page's mock-VPN country selector actually works |
| `OTP_TTL_SECONDS=900`, `JWT_EXPIRES_IN=60m` | Long demo flows don't expire mid-run |
| `DEMO_TEST_RUNNER=true` (backend) | Mounts the runner routes (panel is Windows-broken, but harmless) |
| `NEXT_PUBLIC_DEMO_TEST_RUNNER=true` (frontend) | Renders the login-page panel |

---

## 1. One-time setup

```bash
cd d:/FinSpark/sentinel_fusion_ai/Finspar-X-Bank-Simulator
npm install
npx playwright install chromium         # or: npm run e2e:install
```
Infra containers (Postgres on 5433, the model on 8000):
```bash
docker start finspark-postgres sentinel_fusion_ai-api-1
curl http://localhost:8000/ready         # -> {"ready":true,...}
```

---

## 2. Enable demo mode (each session)

### Git Bash (recommended)

**Terminal 1 — backend (exports the demo env, then starts):**
```bash
cd d:/FinSpark/sentinel_fusion_ai/Finspar-X-Bank-Simulator
eval "$(npm run --silent e2e:env)"
npm run dev:backend:demo
```
✅ Confirm it printed:
```
[FraudModule] SCORER -> Sentinel HttpScorer (http://127.0.0.1:8000)
```
If it says `SCORER -> HeuristicScorer (Phase 1)`, the env wasn't exported — the
demo is NOT using the model. Re-run the `eval` line.

**Terminal 2 — frontend (renders the panel):**
```bash
cd d:/FinSpark/sentinel_fusion_ai/Finspar-X-Bank-Simulator
NEXT_PUBLIC_DEMO_TEST_RUNNER=true npm run dev:frontend
```

Open **http://localhost:3000** — you're in demo mode.

### PowerShell (alternative for Terminal 1)
`e2e:env` prints bash `export` lines, so set them by hand instead:
```powershell
$env:SENTINEL_ENABLED="true"
$env:SENTINEL_URL="http://127.0.0.1:8000"
$env:SENTINEL_API_KEY="sentinel-demo-key-2026"
$env:SENTINEL_TIMEOUT_MS="15000"
$env:GEO_ALLOW_MOCK_COUNTRY="true"
$env:OTP_TTL_SECONDS="900"
$env:JWT_EXPIRES_IN="60m"
$env:DEMO_TEST_RUNNER="true"
npm run dev:backend:demo
```
Frontend (Terminal 2): `$env:NEXT_PUBLIC_DEMO_TEST_RUNNER="true"; npm run dev:frontend`

---

## 2.5 Reset to a clean slate (do this before a full run or a rehearsal)

The Money spec needs **fresh state** — after a session of testing, the demo
customer can end up **frozen** (`SUSPENDED`) by a BLOCK/fraud-report, accounts
carry stale holds, and the model's feature store is polluted. That makes the
"drain" score differently (e.g. `OTP` instead of `BLOCKED`). Reset all three:

```bash
# flush the model's per-entity feature store
docker exec sentinel_fusion_ai-redis-1 redis-cli FLUSHALL

# unfreeze the customer + clear account holds, then reseed
cd apps/backend
node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{const c=await p.customer.findUnique({where:{customerId:'83840226'}});await p.customer.update({where:{id:c.id},data:{status:'ACTIVE'}});await p.account.updateMany({where:{customerId:c.id},data:{holdAmount:0n}});await p.\$disconnect();})();"
npm run prisma:seed
cd ../..
```

## 3. Run the demo scripts (the real way on Windows)

All commands from the simulator root. **`--headed` shows the browser driving the
app** — use it to rehearse and to record.

```bash
# Watch the full visible demo (Money + Habits + console + panel):
npm run e2e:headed

# Model-only watchers (Intrusion, Quantum, Command Center) — needs ONLY the model:
npm run e2e:api

# Browser watchers only (Money, Habits, console, panel) — needs the full stack:
npm run e2e:ui

# Everything (UI + API):
npm run e2e

# Open the HTML report (video + trace of every step):
npm run e2e:report
```

### Run ONE watcher (rehearse a single demo)
```bash
# Money Watcher, visible:
npx playwright test tests/specs/01-money-watcher.spec.ts --headed

# Habits Watcher, visible:
npx playwright test tests/specs/02-habits-watcher.spec.ts --headed

# Intrusion / Quantum / Command Center (model only, no browser):
npx playwright test tests/specs/03-intrusion-watcher.spec.ts
npx playwright test tests/specs/04-quantum-watcher.spec.ts
npx playwright test tests/specs/05-command-center.spec.ts
```

### The specs
| Spec | Project | What it demonstrates |
|---|---|---|
| `01-money-watcher` | ui | new-payee drain → **BLOCKED** (frozen); established payee → **HELD → authorizer releases → send** |
| `02-habits-watcher` | ui | mock-VPN country reaches the model; login is **scored** (not blocked) |
| `03-intrusion-watcher` | api | cyber event → `critical` + contract guards |
| `04-quantum-watcher` | api | quantum critical/low on the **working** lever (`q_data_class`) |
| `05-command-center` | api | routing + calibration + fused verdict |
| `06-sentinel-console` | ui | the `/sentinel` console screens |
| `07-demo-runner-panel` | ui | the login-page panel + runner allowlist |

> **Expected result:** **33 passed, 2 skipped**, and the Money **drain** beat may
> fail. The 2 skips are deliberate `test.fixme`s (Intrusion benign contrast,
> Habits country-raises-risk) — skipped ≠ failed.
>
> **The Money `drain → BLOCKED` assertion is fragile by design.** The
> brand-new-payee score sits *exactly* on the CRITICAL boundary (the walkthrough
> measured it over the edge by 1.5e-8), so tiny feature-store differences flip it
> between `BLOCKED` and `OTP`/`HELD`. A Redis flush makes it worse, not better
> (cold history scores it lower). **The Money Watcher still flags the payment
> either way** — the failure is the strict `toBe('BLOCKED')` assertion, not a
> broken model. The governance beat (HELD → authorizer release → send) then shows
> as *skipped* only because it's serially chained after the failed drain test.
>
> For a live demo this doesn't matter — you present whatever verdict comes back
> (HELD or BLOCKED are both "the money was stopped"). If you want the suite fully
> green, the drain assertion should accept `BLOCKED` **or** `HELD` (a one-line
> spec change).

---

## 4. One-click executable

Create **`run-demo.bat`** at the simulator root (double-click to run the visible
demo — assumes backend + frontend from step 2 are already up):
```bat
@echo off
cd /d d:\FinSpark\sentinel_fusion_ai\Finspar-X-Bank-Simulator
docker start finspark-postgres sentinel_fusion_ai-api-1
call npx playwright test tests\specs\01-money-watcher.spec.ts tests\specs\02-habits-watcher.spec.ts --headed
call npx playwright show-report .artifacts\html-report
pause
```
For a single-watcher one-click, keep just the one spec path on the `npx` line.

---

## 5. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Log says `SCORER -> HeuristicScorer` | Env not exported → re-run `eval "$(npm run --silent e2e:env)"` before the backend |
| Scores time out / fall back mid-run | `SENTINEL_TIMEOUT_MS` too low, or `localhost` used → must be `127.0.0.1:8000`, timeout `15000` |
| Preflight: "model unreachable" | `docker start sentinel_fusion_ai-api-1`; check `curl 127.0.0.1:8000/ready` |
| Preflight: db down | `docker start finspark-postgres` |
| Login-page **buttons** do nothing | Known Windows `spawn npx` bug — **use the terminal commands**, not the buttons |
| Mock-VPN selector does nothing | `GEO_ALLOW_MOCK_COUNTRY=true` not exported on the backend |
| `01-money` fails on a retry | It's stateful (beneficiary code / custRefNo already exist) — reseed: `npm run db:seed` |
| Behaviour test flaky on country | Flush the model's store first: `docker exec sentinel_fusion_ai-redis-1 redis-cli FLUSHALL` |

---

## 6. What NOT to claim on stage (model reality)

The specs assert only what's real. When you present live:
- **Money** ✅ and **Command Center** ✅ — fully trustworthy.
- **Habits** — say "the login is scored and its origin is part of the score." Don't
  claim the foreign login scores higher (country doesn't move it yet).
- **Intrusion** — show the malicious hit only; don't invite a benign re-test (it
  also scores critical).
- **Quantum** — the working contrast is flipping **data sensitivity**
  (`q_data_class`), not the algorithm.

Full detail: `docs/sentinel-demo-walkthrough.md` §7 (symptoms) and
`../sentinel_fusion_ai/docs/MODEL_REMEDIATION_PLAN.md` (how to make all four fully work).
