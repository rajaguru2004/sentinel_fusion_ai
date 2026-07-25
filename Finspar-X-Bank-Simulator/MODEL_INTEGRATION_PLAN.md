# FinSpark Bank Simulator — Model Integration Plan

**Audience:** the bank-simulator team (NestJS).
**Goal:** integrate the live `sentinel_fusion_ai` FastAPI model (Schema v2) into the
banking flows — real ML verdicts on the money path, full-fidelity scoring, and the
training export that lets the model calibrate on real traffic.
**Companion docs:** model side is `sentinel_fusion_ai/docs/BANK_INTEGRATION_IMPROVEMENTS.md`
(what the model added) and `sentinel_fusion_ai/docs/finspark_export_spec.md` (the export contract).

---

## Current state

- The fraud seam already exists: every money operation routes through
  `FraudGateway.assess()` behind a swappable `Scorer` interface.
- Today `SCORER` binds to `HeuristicScorer` (Phase 1). Only **payment initiation**
  is wired to it.
- The model (v2) is running in Docker at `http://localhost:8000` and exposes
  `/score`, `/score/batch`, `/ingest`, `/ingest/batch`, `/feedback`, `/feedback/batch`.
- Missing on our side: the `HttpScorer`, the v2 adapter, the other intercepts,
  the `/ingest` streaming, the feedback loop, and the training export.

**Two tracks, one order.** Steps 1–5 make one model-backed payment work. Steps 6–7
give full coverage and full-fidelity scores. Steps 8–10 are the depth work.

---

## Step 1 — Config + networking

- Add to `common/env.ts` and `.env`:
  `SENTINEL_URL`, `SENTINEL_API_KEY`, `SENTINEL_TIMEOUT_MS` (≈800), `SENTINEL_ENABLED`.
- Put both compose stacks on one shared Docker network so `finspark-backend`
  reaches `sentinel-api:8000` (or use `host.docker.internal` if the model runs on host).
- **Verify:** `curl http://sentinel-api:8000/health` from inside the backend container.

## Step 2 — Build the `HttpScorer`

- New `src/fraud/http-scorer.ts` implementing the existing `Scorer` interface.
- `POST {SENTINEL_URL}/score?explain=true` with header `X-API-Key`, a keep-alive
  HTTP agent, and `SENTINEL_TIMEOUT_MS`.
- Wrap in `try/catch`: on any error/timeout, **fail open** to an injected
  `HeuristicScorer` so payments never freeze on a model outage. Log `degraded`.
- Do **not** wire it in yet.

## Step 3 — Build the adapter (`UnifiedEvent` → v2 `EventIn`)

The v2 `EventIn` now trains on a full banking block — a thin payload wastes the v2 gains.
Populate what we already have; leave the rest null until Step 8.

| v2 `EventIn` field | Source in the simulator |
|---|---|
| `event_id` | **stable, persisted id** (reused on retries — see Step 5) |
| `event_domain` | payment/card → `financial`, login → `behaviour` |
| `event_time` | `new Date().toISOString()` (tz-aware UTC) |
| `user_id`, `device_id` | userId, deviceFingerprint |
| `amount`, `currency`, `payment_type`, `is_credit` | payment |
| `balance_before` / `balance_after` | debit account (paise → major units) |
| `counterparty_age_s` | `beneficiaryAgeMinutes * 60` |
| `counterparty_is_new`, `name_mismatch` | beneficiary / verification |
| `bank_txn_count_1h` | `txnCountLastHour` (existing query) |
| `bank_amount_vs_user_mean` | `amountVsUserMean` (existing aggregate) |
| `bank_beneficiary_age_s`, `bank_is_new_beneficiary` | beneficiary |

Send the `bank_*` block even when it duplicates something the model could compute —
it is trained as an independent view and used as the cold-store fallback.

## Step 4 — Map the v2 response back to `RiskVerdict`

- `risk_score → riskScore`; `risk_level → RiskLevel` (uppercase).
- `contributions → modelScores` — handle the v2 split `p_fraud_payment` /
  `p_fraud_application` (`p_fraud` is a deprecated mirror).
- `explanation.top_features → reasons` (already plain-language in v2).
- Handle `scored: false` (no model covered the event) and the new `degradation{}`
  breakdown.

## Step 5 — Flip the provider + test the payment path

- In `fraud.module.ts`, gate `SCORER`: `SENTINEL_ENABLED ? HttpScorer : HeuristicScorer`.
- Run a payment end to end. **Verify:** a `FraudEvent` row carries the model's
  verdict, and HIGH → HOLD / CRITICAL → BLOCK+freeze fire correctly.
- **Idempotency:** `event_id` must be stable and unique per logical event and
  **reused on retries** — a fresh id per attempt double-advances the model's
  velocity counters.

## Step 6 — Wire the remaining `/score` intercepts

- `login` → `/score` (behaviour model): add `buildLoginEvent` + `assess()` in
  `auth.service.ts`.
- `payment_modify` → `/score`: re-score on the payment-edit path (§8.11).
- Each is the same shape as payment initiation: build event, `assess()`, act on decision.

## Step 7 — Add the `/ingest` streaming client

- New fire-and-forget, **non-blocking** client that posts context events to
  `/ingest` (never on the request's critical path):
  beneficiary add/activate, balance/statement views.
- This warms the feature store so velocity/history stop coming back degraded.
- **Verify:** after streaming a user's context, a subsequent `/score` returns
  `degraded: false` with non-null velocity features.

## Step 8 — Grow the data model

Add the signals the v2 model trains on but the simulator does not yet emit, and
fill them into the adapter as they land:

- Counterparty (beneficiary) balances — destination-balance behaviour is a strong signal.
- Geo (`lat/lon`, `is_foreign_request`) — from IP or synthesized.
- Device/session — `device_os`, `session_length_s`, `channel`, consistent `sessionId`.
- Customer profile — `customer_age`, `account_age_s`, `income` band, `email_is_free`.
- Optional: card purchases + `merchant_category` for the `card_purchase` path.

## Step 9 — Close the feedback loop

- `POST /feedback` (and `/feedback/batch`) on confirmed outcomes — dispute /
  chargeback resolution and analyst confirm/BLOCK.
- Include the confirmation timestamp; it feeds the model's label-lag replay.

## Step 10 — Produce the training export

Per `sentinel_fusion_ai/docs/finspark_export_spec.md`, so the model team can drop
the `finspark_synth` scaffolding and calibrate on real traffic:

- Labeled `.jsonl`/Parquet, `camelCase`, chronological, append-only.
- ≥ 2,000,000 events; 5k–50k customers; **median ≥ 200 events/customer**; ≥ 6 months;
  fraud rate 0.1–1%; **do not pre-balance**.
- **Complete sequences per customer** — never subsample a customer's events.
- **`label.confirmedAt` on every labeled event** (the critical field) — model
  confirmation lag, or accept the synthetic-lag fallback.
- **No label-derived fields** in the payload (`severity`, `riskScore`, `isFlagged`) —
  the leak guard rejects the export otherwise.
- Answer the 4 open questions: `confirmedAt` feasible; chunked vs one run;
  counterparty balances available; repeat offenders modeled.

---

## Milestones

| Milestone | Steps | Result |
|---|---|---|
| **M1 — live payment scoring** | 1–5 | one model-backed transaction, fail-open safe |
| **M2 — full coverage + fidelity** | 6–7 | all intercepts wired, scores no longer degraded |
| **M3 — depth** | 8–10 | richer signals, feedback loop, retraining on real data |

## Guardrails (do not skip)

- **Fail open** on model error — payments must never hang on the ML service.
- **Stable `event_id`** reused across retries — otherwise the feature store corrupts.
- **`/ingest` is always non-blocking** — context streaming never sits on the money path.
- **Never send label-derived fields** to `/score` or in the export.
