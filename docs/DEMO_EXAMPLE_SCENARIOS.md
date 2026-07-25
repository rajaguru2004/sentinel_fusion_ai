# Demo Example Scenarios — Sentinel Fusion AI

> Extracted from the canonical scenario registry defined in the Demo Scenario Framework.
> Each scenario maps to a `demo/scenarios/<id>.scenario.json` file and a `tests/scenarios/<id>.spec.ts` Playwright spec.

---

## Scenario Index

| ID | Title | Watcher | Decision | Status |
|---|---|---|---|---|
| [01-drain](#01-drain--large-drain-block) | Large Drain | `fraud_payment` | `BLOCK` | `stage-ready` |
| [02-governance](#02-governance--maker-checker-hold--release) | Maker-Checker Governance | `fraud_payment` | `HOLD → EXECUTE` | `stage-ready` |
| [03-clean](#03-clean--clean-payment-execute) | Clean Payment | `fraud_payment` | `EXECUTE` | `stage-ready` |
| [04-habits](#04-habits--behaviour-watcher) | Habits / Behaviour | `behaviour` | `HIGH` | `known-divergent` |
| [05-intrusion](#05-intrusion--cyber-watcher) | Intrusion Detection | `cyber` | `CRITICAL` | `known-divergent` |
| [06-quantum](#06-quantum--quantum-future-proofing) | Quantum Future-Proofing | `quantum` | relative ordering | `known-divergent` |

---

## 01-drain — Large Drain (BLOCK)

### Narrative
> *"₹18 lakh sent to a brand-new beneficiary — 15× the customer's typical transaction. Sentinel blocks it before the ledger moves."*

### Overview
- **Watcher:** `fraud_payment`
- **Decision:** `BLOCK`
- **Inspection:** `false`
- **Status:** `stage-ready`

### Key Features Demonstrated

| Feature | Expected Value | Narrative Claim |
|---|---|---|
| `f_amount_ratio_mean` | ≈ 15× | "15× the customer mean" |
| `bank_amount_vs_user_mean` | ≈ 15× | "off-pattern amount" |
| `f_user_distinct_counterparties` | new beneficiary = novel | "brand-new payee" |
| `counterparty_age_s` (BEN005) | ≈ 300s (5 minutes) | "cooling period — payee activated 5 min ago" |

### Temporal Envelope

```json
{
  "backendLocalHour": [9, 19],
  "weekdayOnly": true,
  "forbidPastCutoff": false,
  "railMustBe": "IMPS",
  "maxRunMinutes": 45
}
```

> Payment sent over **IMPS** (exempt from the 19:30 NEFT/RTGS cutoff). The UI must show `"Funds held for analyst review"`, **not** `"Funds held — "` (cutoff-hold masquerade).

### SQL Pins Required

```sql
UPDATE beneficiaries SET "activatedAt" = now() - interval '5 minutes' WHERE code = 'BEN005';
```

### Expected Outcome

```json
{
  "decision": "BLOCK",
  "band": "critical",
  "dominantModel": "fraud_payment",
  "riskScore": { "min": "<measured>", "max": "<measured>" },
  "degradation": {
    "store_unavailable": false,
    "user_history": false
  },
  "contributions": {
    "required": ["f_amount_ratio_mean", "counterparty_age_s", "f_user_distinct_counterparties"],
    "forbidden": []
  },
  "uiText": {
    "visible": ["Account frozen", "Case opened", "Funds held for analyst review"],
    "absent": ["Funds held — "]
  }
}
```

### Fragility Note

> ⚠️ The ₹2,50,000 headline probe recorded `0.2429906576871872` against a critical edge of `0.242990642786026` — over by **1.5e-8**. Any scenario within 10% of a band edge is auto-marked `fragile` and **cannot be `stage-ready`**. Use `distanceToBandEdge` to verify margin.

### Fallback Narrative (Band Drift)
- **HIGH → CRITICAL drift:** Narrate the band. "No money moved, account frozen, case opened" holds for both HOLD and BLOCK.
- **Do not re-run** if the band is adjacent and the story still holds.

---

## 02-governance — Maker-Checker Hold & Release

### Narrative
> *"A legitimate ₹2.5 lakh payment is flagged medium-risk and held for a second authorizer. The authorizer reviews, approves — the ledger moves without touching the model again."*

### Overview
- **Watcher:** `fraud_payment`
- **Decision:** `HOLD → EXECUTE` (authorizer release)
- **Inspection:** `false`
- **Status:** `stage-ready`

### Steps

| Step | Kind | Action | `expectModelCalls` | `expectIngestCalls` |
|---|---|---|---|---|
| 1 | `ui` | Maker initiates payment | `1` | `1` |
| 2 | `ui` | Authorizer logs in, sees HOLD queue | `0` | `0` |
| 3 | `ui` | Authorizer re-confirms (`reviewApproved = true`) | `0` | `0` |
| 4 | `ui` | Payment executes, ledger moves | `0` | `1` |

> **`modelCalls: 0` on re-confirm is a DECLARATION, not an accident** — `payments.service.ts:125` skips the gateway entirely when `reviewApproved = true`. Assert this by declaration in `steps[]`.

### Key Features Demonstrated

| Feature | Expected Value |
|---|---|
| `f_amount_ratio_mean` | ≈ 2.08× (below critical, above normal) |
| `bank_amount_vs_user_mean` | ≈ 2.08× |
| `f_user_txn_count_1h` | `0` (warm window outside 1h) |

### Expected Outcome

```json
{
  "decision": "HOLD",
  "band": "high",
  "dominantModel": "fraud_payment",
  "degradation": {
    "store_unavailable": false,
    "user_history": false
  }
}
```

### Sensitivity Levers

| Lever | From | To | Narrative Claim | Must Measure |
|---|---|---|---|---|
| `amount` | ₹2.5L | ₹18L | `raises` (to BLOCK) | `raises` |
| `counterparty_age_s` | 40 days | 5 minutes | `raises` | `raises` |

---

## 03-clean — Clean Payment (EXECUTE)

### Narrative
> *"A routine ₹50,000 transfer to a known beneficiary of 40 days — Sentinel clears it in milliseconds."*

### Overview
- **Watcher:** `fraud_payment`
- **Decision:** `EXECUTE`
- **Inspection:** `false`
- **Status:** `stage-ready`

### Key Features Demonstrated

| Feature | Expected Value | Narrative Claim |
|---|---|---|
| `f_amount_ratio_mean` | ≈ 0.42× | "well within the customer's normal range" |
| `counterparty_age_s` (BEN001) | ≈ 40 days (3,456,000s) | "established beneficiary" |
| `f_user_txn_count_1h` | `0` | "first transaction of the session" |
| `f_user_secs_since_last` | ≈ 21,600s (6h) | "last transacted 6 hours ago" |

### Expected Outcome

```json
{
  "decision": "EXECUTE",
  "band": "low",
  "dominantModel": "fraud_payment",
  "degradation": {
    "store_unavailable": false,
    "user_history": false
  },
  "uiText": {
    "visible": ["Payment successful"],
    "absent": ["Funds held", "Account frozen"]
  }
}
```

### Beneficiary Pin

```sql
UPDATE beneficiaries SET "activatedAt" = now() - interval '40 days' WHERE code = 'BEN001';
```

---

## 04-habits — Behaviour Watcher

### Narrative
> *"A login from Russia on a device that has only ever connected from India — Sentinel's Behaviour head sees a pattern break."*

### Overview
- **Watcher:** `behaviour`
- **Decision:** `HIGH` (including the home-country login)
- **Inspection:** `false`
- **Status:** `known-divergent`

### Known Divergence

> The `behaviour` model's fitted high edge is **0.1148** — so an **ordinary home login** from India already reads `HIGH`.
> `f_user_new_country` carries approximately **0 learned weight** in the current bundle.

### What the Scenario Asserts (honest)

| Beat | Country | Expected Band |
|---|---|---|
| Home login | `IN` | `high` |
| Foreign login | `RU` | `high` |

### What the Scenario Does NOT Claim
- ❌ "New country raises risk" — **measured as `inert`**
- ❌ The mock-VPN selector changes the score — **it does not**

### What IS True and Demonstrable
- The mock-country header (`X-Mock-Country: RU`) is captured by the interceptor, survives to the gateway, and is sent to the model.
- The login IS scored by the `behaviour` head.
- `country` field reaches `feat:u:{uid}:cty` in the feature store.
- The existing `test.fixme` in `tests/specs/02-habits-watcher.spec.ts` is the **visible gap marker** — leave it as a skip.

### `divergenceNote`

```
"behaviour" fitted high edge is 0.1148; ordinary home logins read HIGH.
f_user_new_country carries ~0 learned weight in the current bundle.
Do not claim "new country raises risk." Assert HIGH for both home and foreign login.
Country field is captured and sent to the model — demonstrate that, not a band change.
```

### Temporal Envelope

```json
{
  "backendLocalHour": [9, 19],
  "weekdayOnly": true,
  "forbidPastCutoff": true,
  "maxRunMinutes": 30
}
```

---

## 05-intrusion — Cyber Watcher

### Narrative
> *"A high-severity device event — file access at 3 AM on an unregistered endpoint — is flagged CRITICAL. A benign baseline event is also CRITICAL. The Cyber head is a detector; both calls score at the top."*

### Overview
- **Watcher:** `cyber`
- **Decision:** `CRITICAL` (for both malicious and benign contrast)
- **Inspection:** `false`
- **Status:** `known-divergent`

### Known Divergence

> `cyber` is in `FROZEN_MODELS` (`feature_spec.py:178`) — never refit on v2.
> Still carries the severity-derived leak `f_device_past_hisev_count`.
> **Effectively always `critical`** regardless of event content.

### What the Scenario Asserts (honest)

| Beat | Event Type | Expected Band |
|---|---|---|
| Malicious event | High-severity device access | `critical` |
| Benign contrast | Normal login event | `critical` |

### What the Scenario Does NOT Do
- ❌ Run the contrast beat as a "before/after" band comparison — it will not show a band difference.
- The `DEMO_PRESENTATION.md §8.4` contrast beat is **wrong as written**.
- The existing `test.fixme` in `tests/specs/03-intrusion-watcher.spec.ts` documents exactly this — leave it skipped.

### Stage Guidance
- Present the `cyber` head as **a detector** — it triggers on the event class, not on a nuanced score.
- Describe the frozen-model situation honestly if asked: *"The cyber bundle is pinned at an earlier version pending a retrain against v2 data."*

### `divergenceNote`

```
"cyber" head is in FROZEN_MODELS (feature_spec.py:178), refit on v1 only.
f_device_past_hisev_count is a severity-derived feature leak — model is always critical.
Do NOT run the benign-contrast beat as a band comparison.
Assert CRITICAL for both beats. Narrative: present as a detector, not a discriminator.
```

---

## 06-quantum — Quantum Future-Proofing

### Narrative
> *"Three quantum-readiness signals — key exchange algorithm, certificate key type, certificate validity days — are evaluated. The score reflects the data classification of the asset being protected."*

### Overview
- **Watcher:** `quantum`
- **Decision:** relative ordering across data classes
- **Inspection:** `false`
- **Status:** `known-divergent`

### Known Divergence

> `quantum` has **no fitted bands** — falls back to `RISK_BANDS` `0.25 / 0.50 / 0.75` from `ml/config.py:95`.
> Only `q_data_class` meaningfully moves the score.
> `q_key_exchange`, `q_cert_key_type`, `q_cert_validity_days` are each **measured as `inert`**.

### What the Scenario Asserts (honest)

| Data Class | Expected Relative Score |
|---|---|
| `secret` | highest |
| `internal` | medium |
| `public` | lowest |

> Assert **relative ordering** (`secret > internal > public`), which is real and measurable.
> Do **not** assert an absolute band — bands here are fallback constants, not fitted.

### What the Narrative Claims vs. What Is True

| Claim | Reality | Measured |
|---|---|---|
| "Three factors drive the score" | Only `q_data_class` moves the score | ❌ |
| `q_key_exchange` matters | `inert` | ❌ |
| `q_cert_key_type` matters | `inert` | ❌ |
| `q_cert_validity_days` matters | `inert` | ❌ |
| "Score reflects data sensitivity" | ✅ True | ✅ `raises` |

### `divergenceNote`

```
"quantum" has no fitted bands; uses fallback RISK_BANDS (0.25/0.50/0.75).
Only q_data_class moves the score. q_key_exchange, q_cert_key_type, q_cert_validity_days
are all measured inert. Assert relative ordering across data classes (secret > internal > public).
Do not assert an absolute band or claim three driving factors.
demo:report will print these levers red under "Claim vs Measured".
```

---

## Common Warm-Up Profile (All Stage-Ready Scenarios)

All `stage-ready` scenarios share the same base warm-up for the **Vantage Textiles maker** account:

| Seq Range | Offset from T0 | Domain / Type | Features Built |
|---|---|---|---|
| `0000–0059` | −45d … −7d (business hours) | `financial / PAYMENT_INITIATE` | `f_user_seq_no`, `f_amount_z_user`, `f_amount_ratio_mean`, `f_user_distinct_counterparties`, `f_merchant_category_novel` |
| `0060–0089` | −45d … −2d | `behaviour / LOGIN` (country: `IN` only) | `f_device_seq_no`, `cty SET = {IN}` (so first foreign login is genuinely new) |
| `0090` | **−6h** | Last routine payment | `f_user_secs_since_last` ≈ 21,600s ± presenter delta → < 3% variance |
| — | **nothing inside −3600s** | — | `f_user_txn_count_1h` = deterministic `0` |

> **Declared Extras:** warm-up sends `counterparty_id` and `merchant_category`, which the live adapter never sends.
> This is **not cheating** — it is the only way `f_user_distinct_counterparties` reflects a real customer instead of `0`.
> Listed in `preload.warm.declaredExtras` and stated in the generated runbook.

---

## Scenario Status Definitions

| Status | Meaning |
|---|---|
| `stage-ready` | ≥ 3 consecutive green rehearsals **and** `fragile === false` **and** every `sensitivity[].measured` matches `narrativeClaims`. May be presented live. |
| `rehearsal-only` | Passes locally but fails `fragile` check or has unmeasured levers. Do not present live. |
| `known-divergent` | Model behaviour diverges from the narrative claim. Scenario asserts **what the model actually does**. Contains a `divergenceNote`. May be presented with honest narration only. |

---

## No-Bypass Declaration

Every score in every scenario comes from `POST /score` through the real bundles.
History is created **only** through real endpoints (`prisma:seed`, `POST /ingest`, `POST /feedback`).
No hardcoded predictions. No bypasses.

The **sealed probe** (last warm event re-POSTed to `/score?explain=true`) reproduces its baseline `risk_score` to `1e-12` — a result only possible from the same bundle + isotonic calibrator + feature vector. `HeuristicScorer` cannot land on `0.2429906576871872`.
