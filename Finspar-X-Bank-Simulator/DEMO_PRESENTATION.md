# Sentinel Fusion AI × FinSpark — Live Demo Presentation Guide

> **Purpose.** A stage-ready script for demonstrating all **four Sentinel models
> + the Command Center** using the FinSpark bank simulator. Each model gets a
> vivid, real, end-to-end example the jury can *watch happen*. This document is
> also the source of truth for the **Playwright automation** that will replay
> these demos hands-free — every step lists concrete actions, selectors, inputs,
> and expected outcomes.

---

## 0. The 30-second opener (say this first)

> "A bank isn't attacked in one way — it's attacked from four directions at once.
> Someone drains an account, someone breaks into a server, someone hijacks a
> login, and someone quietly steals encrypted secrets to crack later. **Sentinel
> runs four specialist watchers, and a Command Center that fuses them into one
> verdict.** Let me show you all four — live — inside a real banking app."

Then run the four scenarios in order (§5). Each is ~2 minutes.

---

## 1. The four watchers + the Command Center

| # | Watcher (plain words) | Catches | Under the hood | Domain key |
|---|---|---|---|---|
| 1 | **The Money Watcher** — watches every payment; knows each customer's normal | stolen-card buys, drained accounts, fake sellers | Fraud Detection — **XGBoost** | `financial` → `fraud_payment` |
| 2 | **The Intrusion Watcher** — watches computers & network traffic | hacking tools, data theft, malware calling home | Cyber Threat Detection — **LightGBM** | `cyber` |
| 3 | **The Habits Watcher** — learns each person's routine | stolen passwords, account takeovers, impossible travel | Behaviour Analytics — **LightGBM** | `behaviour` |
| 4 | **The Future-Proofing Watcher** — checks the locks on secrets | harvest-now-decrypt-later theft | Quantum Risk — **XGBoost** | `quantum` |
| ★ | **The Command Center** — listens to all four at once | one loud alarm *or* several quiet worries | Weighted **noisy-OR** fusion + isotonic calibration | all |

**The Command Center's rule of thumb:** one model screaming `critical` escalates on
its own; but several models each mildly worried *also* add up to a high final
verdict. Output is always **one** threat level: `low / medium / high / critical`.

---

## 2. Demo architecture — what's live-UI vs API (read this before presenting)

The bank simulator naturally produces **financial** and **behaviour** telemetry —
so **Money** and **Habits** demo *inside the live web app* (the showstoppers). A
bank does **not** emit raw network packets or TLS-certificate inventories, so
**Intrusion** and **Quantum** are demoed by sending a crafted event straight to
the model's `/score` API (shown in a terminal / the automation harness). This is
honest and still visual — the jury sees the model return `CRITICAL` in real time.

| Scenario | How it's shown | Surface |
|---|---|---|
| 1 — Money Watcher | **Live UI**: add payee → pay → held → analyst releases | FinSpark web app |
| 2 — Habits Watcher | **Live UI**: log in from a new country (mock VPN) | FinSpark web app |
| 3 — Intrusion Watcher | **API**: POST a network event to `/score` | Terminal / harness |
| 4 — Future-Proofing | **API**: POST a certificate event to `/score` | Terminal / harness |
| ★ — Command Center | **API**: one response's `contributions` + fused level | Terminal / harness |

> Present 1 and 2 as the emotional core (money + identity — what a jury *feels*),
> then 3 and 4 as the "and it also guards the machines and the future" reveal.

---

## 3. Pre-demo setup checklist

Run once, before the jury walks in. All three must be green.

1. **Model up** (Sentinel):
   ```
   docker start sentinel_fusion_ai-api-1
   curl http://localhost:8000/ready      # -> {"ready":true,...}
   ```
2. **Warm the SHAP explainer** (first explained call is slow — do it now, not on stage):
   ```
   curl -s -X POST 'http://localhost:8000/score?explain=true' \
     -H 'X-API-Key: sentinel-demo-key-2026' -H 'Content-Type: application/json' \
     -d '{"event_id":"warm","event_domain":"financial","event_time":"'"$(node -e 'console.log(new Date().toISOString())')"'","event_type":"PAYMENT_INITIATE","amount":1000,"currency":"INR"}' >/dev/null
   ```
   (The backend also fires a warmup on boot via `SentinelWarmup`.)
3. **Backend up** (fraud gateway pointed at the model):
   ```
   cd apps/backend && npm run start:dev
   # console must show: [FraudModule] SCORER -> Sentinel HttpScorer (http://127.0.0.1:8000)
   ```
   > Backend on the **host** must use `SENTINEL_URL=http://127.0.0.1:8000` (NOT
   > `localhost` — Node resolves it to IPv6 and times out; NOT
   > `host.docker.internal` — that only resolves inside Docker).
4. **Frontend up**: `cd apps/frontend && npm run dev` → open `http://localhost:3000`.
5. **Reset demo data** (optional, for a clean run): `cd apps/backend && npm run prisma:seed`.
6. Put a **terminal tailing the backend console** on screen — the live
   `[Sentinel /score] ... ->` JSON is a star of the show.

---

## 4. Demo credentials & endpoints

| Thing | Value |
|---|---|
| Customer Id | `83840226` |
| Maker (initiates payments) | `TARAKESH` / login `Finspark@123` |
| Authorizer (releases holds) | `PRIYA_A` / login `NewPass@999` |
| Viewer | `ROHIT_V` / `Finspark@123` |
| Transaction password | `Txn@12345` |
| OTP (mock, everywhere) | `123456` |
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:3001/api |
| Model API | http://localhost:8000 (key `sentinel-demo-key-2026`) |

---

## 5. The presentation flow (running order)

```
Opener (§0)
  → Scenario 1  The Money Watcher      (live UI, ~3 min)   ★ headline
  → Scenario 2  The Habits Watcher     (live UI, ~2 min)
  → Scenario 3  The Intrusion Watcher  (API, ~1 min)
  → Scenario 4  The Future-Proofing    (API, ~1 min)
  → Command Center finale (§10)        (API, ~1 min)
Close: "Four watchers, one verdict, zero blind spots."
```

---

## 6. Scenario 1 — The Money Watcher  *(LIVE UI — the headline)*

### 6.1 The story (say this)
> "Meet a fraudster who's stolen a customer's banking login. The first thing they
> do is add a **brand-new payee they control**, then immediately push money to it.
> To a human that looks like a normal transfer. Watch what the Money Watcher does."

### 6.2 What we'll trigger, and why it fires
A **first-ever payment to a beneficiary added minutes ago**, for an amount unlike
the customer's usual pattern. The `fraud_payment` (XGBoost) model treats *new
counterparty + first payment + off-pattern amount* as a classic account-drain
shape → verdict **HIGH → the payment is HELD** before any money moves.

### 6.3 Step-by-step execution (Playwright-ready)

| # | Actor | Action | Selector / input | Expected |
|---|---|---|---|---|
| 1 | TARAKESH | Log in | Customer `83840226`, User `TARAKESH`, Password `Finspark@123`, CAPTCHA (read from `.sr-only` span), **Mock VPN = Auto** | Dashboard loads |
| 2 | | Go to **Beneficiary → Beneficiary Maintenance** | sidebar | Beneficiary table shows |
| 3 | | **Add New** beneficiary | Code `DEMO01`, Name `Quick Cash Traders`, Account `50100234567890`, IFSC `HDFC0001234`, Type **IMPS** | Created (status PENDING) |
| 4 | | **Activate** it | Beneficiary Activate screen → select `DEMO01` → Activate | status ACTIVE, `activatedAt` = now |
| 5 | | Go to **Payments → Initiate Payment** | sidebar | Form shows |
| 6 | | Fill payment | Debit account = the SAVINGS/CURRENT acct, Beneficiary `DEMO01`, Amount `250000`, Rail **IMPS**, Cust Ref `DEMO-DRAIN-1` | |
| 7 | | **Confirm** | Confirm button | **Outcome: HELD** — "Funds held for analyst review" |
| 8 | Presenter | Switch to the **backend console** | — | `[Sentinel /score] PAYMENT_INITIATE ... risk_level:"high"` with reasons |
| 9 | | Open **Analyst Dashboard** (`/analyst`) | sidebar / URL | Payment appears in **"Held payments — awaiting review"** |

### 6.4 Under the hood (narrate while step 8 is on screen)
- The confirm call built a `UnifiedEvent` and routed it through
  `FraudGateway.assess()` → `HttpScorer` → `POST /score?explain=true`.
- The model returned (real shape):
  ```json
  { "model": "fraud_payment", "risk_level": "high", "risk_score": 0.044,
    "explanation": { "reasons": [
      "beneficiary was added 2 minutes ago",
      "first ever payment to this beneficiary",
      "unusual transaction amount",
      "unusual number of known payees" ] } }
  ```
- **Talking point — why 0.044 is "high":** fraud is rare, so this model's scores
  are compressed near zero. It uses **per-model, cost-optimally fitted bands**
  (not a round 0.25/0.50/0.75), so a small calibrated number is genuinely a high
  alert. The **`risk_level` is authoritative**, not the raw number.
- Decision map: `HIGH → HOLD`. The ledger moved the funds into `holdAmount` and
  set the payment `HELD` — **no money left the bank**.

### 6.5 The redemption beat (show the workflow, not just the block)
| # | Actor | Action | Expected |
|---|---|---|---|
| 10 | Log out, log in as **PRIYA_A** (`NewPass@999`) | Authorizer session |
| 11 | Analyst Dashboard → held card → click **Release** on the payment | "Payment approved — ready to authorise & send" |
| 12 | Go to **Payments**, open the payment, **Authorize & Send** (txn `Txn@12345`, OTP `123456`) | Completes — **no re-hold** |

> **Why this beats a plain "blocked" demo:** it shows a *governed* workflow —
> the AI holds, a human **authorizer** (separation of duties: maker `TARAKESH`
> cannot release his own payment; only `PRIYA_A` can) reviews and releases, and a
> released payment is **not re-scored** (`reviewApproved`), so it doesn't loop.

### 6.6 The "wow"
No money moved until a *second human* approved it — and the machine caught a
transfer that looked perfectly ordinary to a person.

---

## 7. Scenario 2 — The Habits Watcher  *(LIVE UI)*

### 7.1 The story (say this)
> "This customer always banks from Pune, on their phone, in the evening. Tonight,
> their password shows up **from Amsterdam**. Same password — but is it the same
> person? The Habits Watcher has learned their routine."

### 7.2 What we'll trigger
Two logins seconds apart from **two different countries** — *impossible travel*.
We use the built-in **Mock VPN** selector on the login page (dev feature) to place
the login in another country without a real VPN. The `behaviour` (LightGBM) model
scores the second login **HIGH** on new-country + implausible timing.

### 7.3 Step-by-step execution (Playwright-ready)

| # | Action | Selector / input | Expected |
|---|---|---|---|
| 1 | Log in normally | User `TARAKESH`, Mock VPN = **🇮🇳 India** | Establishes "home" = IN |
| 2 | Log out | | |
| 3 | Log in again immediately | Same user, Mock VPN = **🇳🇱 Netherlands** (select `#mock-country`) | Login succeeds (scored, non-blocking) |
| 4 | Presenter → **backend console** | — | `[Sentinel /score] LOGIN ... country=NL ... risk_level:"high"` |
| 5 | Open **Analyst Dashboard** → Live feed | | LOGIN row, **HIGH**, reason **"unusual new country for this customer"** |

### 7.4 Under the hood (narrate)
- The login isn't *blocked* (a false lockout is bad UX) — it's **scored and
  recorded**, and the risk drives step-up policy. The model response:
  ```json
  { "model": "behaviour", "risk_level": "high",
    "contributions": { "p_behaviour": 0.188 },
    "explanation": { "reasons": [
      "unusual new country for this customer",
      "unusual time since previous activity" ] } }
  ```
- **Where the country comes from:** the client IP, geolocated **offline**
  (`geoip-lite`) in the fraud gateway. A VPN's exit country flowing through is the
  feature *working* — a foreign login on an India-only account *should* raise risk.
- **Impossible travel:** `f_user_secs_since_last` is tiny (two logins seconds
  apart) while the country jumped IN→NL — physically impossible, so the score rises.
- **It self-corrects:** after a few *authenticated* logins from NL, the model
  learns the customer travels and stops flagging it — no permanent penalty.

### 7.5 The "wow"
Same correct password, yet the system knew it wasn't the same *person* — from
*where* and *how* the login behaved, not *what* was typed.

---

## 8. Scenario 3 — The Intrusion Watcher  *(API)*

### 8.1 The story (say this)
> "It's not always about money. A server inside the bank gets compromised. At 2am
> it quietly ships **9 megabytes out to a stranger on port 4444** — the fingerprint
> of malware phoning home with stolen data. The Intrusion Watcher never sleeps."

### 8.2 Execute (terminal / harness)
```bash
NOW=$(node -e "console.log(new Date().toISOString())")
curl -s -X POST 'http://localhost:8000/score?explain=true' \
  -H 'X-API-Key: sentinel-demo-key-2026' -H 'Content-Type: application/json' \
  -d '{"event_id":"intrusion-demo","event_domain":"cyber","event_time":"'"$NOW"'",
       "user_id":"db-server-07","event_type":"connection",
       "bytes_in":500,"bytes_out":9000000,
       "src_port":49230,"dst_port":4444,"protocol":"tcp","duration_s":1.2}'
```

### 8.3 Expected (verified live)
```json
{ "model": "cyber", "risk_level": "critical", "risk_score": 1.0, "scored": true }
```

### 8.4 Under the hood (narrate)
- A **huge outbound-to-inbound byte ratio** (9 MB out, 0.5 KB in) to a classic
  malware C2 port (**4444**) over a 1.2s burst is textbook exfiltration.
- LightGBM weighs bytes-out, port reputation, protocol and duration together —
  no single rule, a learned pattern — and returns **CRITICAL**.
- **Contrast beat (optional):** re-run with `bytes_out: 2000, dst_port: 443` (a
  normal HTTPS fetch) → the model returns **low**. Same shape of event, opposite
  verdict — it's learned, not hard-coded.

---

## 9. Scenario 4 — The Future-Proofing Watcher  *(API)*

### 9.1 The story (say this)
> "The scariest attacker steals data they **can't even read yet**. They copy
> encrypted secrets today and wait for a quantum computer to crack them tomorrow —
> 'harvest now, decrypt later.' If your most sensitive data is guarded by an old
> lock with a 10-year life, that's a time bomb. This watcher finds the weak locks."

### 9.2 Execute (terminal / harness)
```bash
NOW=$(node -e "console.log(new Date().toISOString())")
curl -s -X POST 'http://localhost:8000/score?explain=true' \
  -H 'X-API-Key: sentinel-demo-key-2026' -H 'Content-Type: application/json' \
  -d '{"event_id":"quantum-demo","event_domain":"quantum","event_time":"'"$NOW"'",
       "user_id":"payments-tls","q_key_exchange":"RSA-2048","q_cert_key_type":"RSA",
       "q_data_class":"secret","q_cert_age_days":30,"q_cert_validity_days":3650}'
```

### 9.3 Expected (verified live)
```json
{ "model": "quantum", "risk_level": "critical", "risk_score": 0.9, "scored": true }
```

### 9.4 Under the hood (narrate)
- The service protects **secret**-class data but still uses **RSA-2048** (quantum-
  breakable) with a **10-year (3650-day)** certificate — meaning the secret stays
  reachable long enough for future quantum decryption.
- XGBoost combines data sensitivity × algorithm weakness × certificate lifetime →
  **CRITICAL**: rotate to post-quantum crypto now.
- **Contrast beat (optional):** `q_cert_key_type: "Kyber", q_cert_validity_days: 90`
  (post-quantum algorithm, short life) → **low**.

---

## 10. The Command Center — the fusion finale  *(API)*

### 10.1 The story (say this)
> "Any one watcher can be fooled by an attacker who stays just under its radar. The
> Command Center hears all four at once — one scream escalates, but **several
> whispers also add up.** Out comes one number the bank can act on."

### 10.2 Show it (in any of the responses above)
Every `/score` response already carries the **`contributions`** block and the
**fused `risk_level`**:
```json
"contributions": {
  "p_fraud_payment": 0.04, "p_behaviour": null, "p_cyber": null, "p_quantum": null
}
```
Point out: for a payment, only the fraud head fires; for a login, only behaviour.
The Command Center **calibrates** each model's raw output (isotonic regression) so
the numbers are comparable, then fuses via **weighted noisy-OR** — the maths of
"the more independent worries, the higher the combined alarm."

### 10.3 The one-line close
> "Four specialist watchers. One fused verdict. No blind spot — money, machines,
> identity, and the future, all watched at once."

---

## 11. Playwright automation notes (for the future script)

**Two drivers, matching §2:**
- **UI scenarios (1, 2)** → Playwright **browser** automation.
- **API scenarios (3, 4, Command Center)** → Playwright **`request`** context
  (`request.post('http://localhost:8000/score?explain=true', { headers, data })`)
  — no browser needed; assert on `risk_level`.

**Known automation hooks & gotchas:**
- **CAPTCHA on login is automatable:** the expected code is rendered in a hidden
  `<span class="sr-only">{captchaCode}</span>` — read it, then fill the CAPTCHA
  input with the same value. (It's a demo stub, not a real captcha service.)
- **Mock VPN** country: `<select id="mock-country">` — `selectOption('NL' | 'IN' | …)`.
  Persists to `localStorage['mock-country']`; clear it (Auto) between tests.
- **Device fingerprint / mock country** flow to the model as headers — no action
  needed; the app sends them.
- **Assertions:**
  - Money: after Confirm, assert the toast/outcome contains `HELD`; assert the
    payment appears under `GET /api/analyst/held`.
  - Habits: assert `GET /api/analyst/feed` newest `LOGIN` row has `riskLevel: "HIGH"`.
  - Intrusion/Quantum: assert the `/score` JSON `risk_level === "critical"`.
- **Determinism:** run `prisma:seed` before a suite; use unique `custRefNo` and
  beneficiary `code` per run (timestamp suffix) to avoid duplicate-key errors.
- **Timing:** allow up to ~6s on the *first* scored call (SHAP warmup) — or hit the
  warmup endpoint in global setup. Warm calls are <100ms.
- **Roles:** release/reject require the **AUTHORIZER** (`PRIYA_A`); a maker session
  gets `403`. Assert both the happy path and the forbidden path.

**Suggested Playwright spec layout:**
```
tests/demo/
  01-money-watcher.spec.ts      (browser: add payee → pay → HELD → release → send)
  02-habits-watcher.spec.ts     (browser: IN login → NL login → HIGH in feed)
  03-intrusion-watcher.spec.ts  (request: cyber event → critical)
  04-quantum-watcher.spec.ts    (request: quantum event → critical)
  05-command-center.spec.ts     (request: assert contributions + fused level)
  global-setup.ts               (start check /ready, warm SHAP, seed)
```

---

## 12. Jury-engagement cheat-sheet

- **Lead with feeling:** money (Scenario 1) and identity (Scenario 2) first — the
  jury *feels* those. Machines and quantum are the "it also covers everything else"
  reveal.
- **Show, then explain:** trigger the outcome first (HELD / CRITICAL), *then* flip
  to the console and explain the reasons. Effect before mechanism.
- **Use the model's own words:** the plain-language `reasons` ("beneficiary was
  added 2 minutes ago") land harder than any slide.
- **The governance beat (Scenario 1 release):** juries reward *responsible* AI —
  the machine advises, a human authorizer decides, separation of duties enforced.
- **The contrast beats (Scenarios 3–4):** re-run with benign inputs → `low`.
  Proves it's *learned judgment*, not a keyword blocklist.
- **The one closing line:** *"Four watchers, one verdict, zero blind spots."*
```
