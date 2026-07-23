# Sentinel Fusion AI — Scoring API (Banking Integration Guide)

Real-time risk scoring over HTTP. One event in → one calibrated risk verdict out.
The service wraps the trained multi-model scorer (`ml.predict.SentinelScorer`) and
computes the model's historical features live from an online feature store.

## Run it

```bash
# Local (in-memory store, no auth) — for a quick look:
pip install -e ".[serve]"
SENTINEL_REQUIRE_AUTH=false uvicorn service.app:create_app --factory --port 8000

# Full stack (API + Redis feature store):
export SENTINEL_API_KEYS="your-secret-key"
docker compose up --build
# add Prometheus:  docker compose --profile monitoring up --build
```

Interactive docs: `http://localhost:8000/docs`.

## Auth

Every `/score`, `/score/batch`, `/feedback` call requires a header:

```
X-API-Key: your-secret-key
```

Keys are injected via `SENTINEL_API_KEYS` (comma-separated) — never baked into the
image. `/health`, `/ready`, `/metrics` are unauthenticated for orchestrators.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/health` | liveness (always 200) |
| GET  | `/ready` | readiness (503 until scorer loaded + store reachable); reports `contract_hash` |
| POST | `/score` | score one event (`?explain=true` for SHAP + plain-language reasons) |
| POST | `/score/batch` | score up to `SENTINEL_MAX_BATCH` events |
| POST | `/ingest` | **build history without scoring** — 202, no inference |
| POST | `/ingest/batch` | bulk context events |
| POST | `/feedback` | confirm an event's true label |
| POST | `/feedback/batch` | bulk adjudication backfill |
| GET  | `/metrics` | Prometheus metrics |

### Which endpoint for which bank event

`/score` costs model inference; `/ingest` does not. Both advance the customer's
history, and history is what makes velocity and amount-vs-normal features work —
so **stream context events even though they need no verdict**.

| FinSpark event | endpoint | routed model |
|---|---|---|
| payment initiation | `/score` | `fraud_payment` |
| card purchase | `/score` | `fraud_payment` |
| account opening | `/score` | `fraud_application` |
| login | `/score` | `behaviour` |
| beneficiary add / activate | `/ingest` | — |
| balance check, statement view | `/ingest` | — |

Without the `/ingest` stream the store stays empty, every payment scores with
`degradation.user_history = true`, and velocity never fires.

## Idempotency

`event_id` is the idempotency key for `/score`, `/score/batch` and `/ingest`. A
retry returns the same features and advances the customer's counters **exactly
once** — without this a network retry double-counts velocity and corrupts every
later score for that customer. Retry freely.

## Score one event

```bash
curl -sS http://localhost:8000/score \
  -H "X-API-Key: your-secret-key" -H "Content-Type: application/json" \
  -d '{
    "event_id": "txn-100493",
    "event_domain": "financial",
    "event_time": "2026-07-23T14:05:00Z",
    "event_type": "card_txn",
    "user_id": "cust-8841",
    "amount": 4210.55,
    "country": "GB"
  }'
```

```json
{
  "event_id": "txn-100493",
  "model": "fraud",
  "raw_score": 0.83,
  "risk_score": 0.71,
  "risk_level": "high",
  "scored": true,
  "contributions": {"p_fraud": 0.71, "p_cyber": null, "p_behaviour": null, "p_quantum": null},
  "model_version": "dev",
  "degraded": false,
  "explanation": null
}
```

### Input fields

Required: `event_id`, `event_domain` (`financial|cyber|behaviour|quantum|threat_intel`),
`event_time` (**tz-aware** ISO-8601 UTC). Everything else is optional — send what you
have; missing fields are handled natively by the models.

Commonly supplied: `user_id`, `device_id`, `event_type`, `event_subtype`, `country`,
`amount`, `bytes_in`, `bytes_out`, `src_port`, `dst_port`, `protocol`, `duration_s`,
`severity`. Quantum events also take `q_key_exchange`, `q_cert_key_type`,
`q_data_class`, `q_cert_age_days`, `q_cert_validity_days`.

Notes:
- Unknown fields are **rejected** (422) — protects the contract from silent typos.
- `severity` is **not** a scoring feature; it only feeds a device's high-severity
  history for future events.
- `event_domain: threat_intel` is not modelled → returns `scored=false`, risk `0/low`.

### Banking fields (schema v2)

The bank's own context signals are now accepted **and trained on** — v1 rejected
them outright (`extra="forbid"`) and the model never saw them:

`counterparty_id`, `counterparty_country`, `counterparty_is_new`,
`counterparty_age_s`, `name_mismatch`, `balance_before`, `balance_after`,
`counterparty_balance_before/after`, `customer_age`, `account_age_s`, `income`,
`channel`, `device_os`, `device_is_new`, `session_length_s`,
`is_foreign_request`, `email_is_free`, `merchant_id`, `merchant_category`,
`geo_lat/lon`, `counterparty_lat/lon`, `currency`, `payment_type`, `is_credit`.

Plus the bank-computed block (§3.3), mapped from FinSpark's own names:

| send | FinSpark field |
|---|---|
| `bank_txn_count_1h` | `txnCountLastHour` |
| `bank_amount_vs_user_mean` | `amountVsUserMean` |
| `bank_beneficiary_age_s` | `beneficiaryAgeMinutes` × 60 |
| `bank_is_new_beneficiary` | `isNewBeneficiary` |

**Precedence:** a store-computed `f_*` wins whenever it is available; the `bank_*`
value seeds the equivalent when the store is cold or unreachable. Send both — the
`bank_*` fields are independent trained features, not just a fallback.

### Output fields

- `risk_score` ∈ [0,1], `risk_level` ∈ {low, medium, high, critical}.
- `model` — which specialist scored it (`fraud_payment`, `fraud_application`,
  `cyber`, `behaviour`, `quantum`); `null` when unscored.
- `contributions` — per-model calibrated probabilities. `p_fraud` is a
  **deprecated** mirror of whichever fraud head fired; read `p_fraud_payment` /
  `p_fraud_application`.
- `degradation` — per-group breakdown (§4.1), so the bank can tell a normal
  cold-start from an incident:

  | field | meaning | action |
  |---|---|---|
  | `store_unavailable` | feature store timed out / errored | **alert**; consider the heuristic fallback |
  | `user_history` | no prior events for this customer | normal for a new customer; stream `/ingest` |
  | `device_history` | no prior events for this device | normal for a new device |
  | `bank_context_used` | a `bank_*` value filled a missing `f_*` | informational |

  `degraded` (plain bool) is kept for one release as the legacy mirror.
- `explanation` — with `?explain=true`: `top_features` (SHAP, machine-readable)
  and `reasons` (plain language for the analyst feed), e.g.
  `["amount is far outside this customer's usual range", "first ever payment to
  this beneficiary"]`. `reasons` is empty when nothing notable fired — benign
  traffic gets no invented narrative.

> **Risk bands.** A calibrated model at a realistic fraud base rate rarely
> produces scores above 0.25, so the fixed `<.25` low / `<.50` medium cut points
> will report most traffic as `low` even when a score is a large *lift* over the
> base rate. Band thresholds should be recalibrated on FinSpark traffic — see
> `reports/ml/MODELS.md` and requirements §4.3.

## Batch

```bash
curl -sS http://localhost:8000/score/batch \
  -H "X-API-Key: your-secret-key" -H "Content-Type: application/json" \
  -d '{"events": [ {...event...}, {...event...} ]}'
```

Returns `{"results": [ ScoreOut, ... ]}` in input order. Events for the same user are
advanced through the feature store in time order internally.

## Feedback (closes the risk-history loop)

The `f_user_past_malicious_rate` feature needs confirmed labels, which arrive after
scoring (chargeback, SOC adjudication). Post them back so the user's risk history
sharpens over time:

```bash
curl -sS http://localhost:8000/feedback \
  -H "X-API-Key: your-secret-key" -H "Content-Type: application/json" \
  -d '{"event_id": "txn-100493", "user_id": "cust-8841", "label": 1}'
```

`label`: 1 = confirmed malicious/fraud, 0 = confirmed benign. Idempotent per
`event_id` (`applied=false` on a duplicate).

## Configuration (env, prefix `SENTINEL_`)

| Var | Default | Meaning |
|---|---|---|
| `SENTINEL_MODELS_DIR` | `<repo>/models` | trained bundle location |
| `SENTINEL_MODEL_VERSION` | `dev` | version string echoed in responses |
| `SENTINEL_API_KEYS` | — | comma-separated valid keys |
| `SENTINEL_REQUIRE_AUTH` | `true` | set `false` only for local dev |
| `SENTINEL_REDIS_URL` | — | e.g. `redis://redis:6379/0`; unset → in-memory store |
| `SENTINEL_STATE_TTL_SECONDS` | 90d | per-entity state retention |
| `SENTINEL_STORE_TIMEOUT_MS` | 50 | per-request store budget before degrading |
| `SENTINEL_MAX_BATCH` | 1000 | batch size cap |
| `SENTINEL_ENABLE_EXPLAIN` | true | allow `?explain=true` (needs the `train`/shap extra) |
| `SENTINEL_REJECT_FUTURE_EVENTS_SECONDS` | 300 | clock-skew guard |

## Operational notes

- **Stateless workers**: all mutable state lives in Redis, so scale horizontally with
  no session affinity. In-memory store is per-process (dev/single-worker only).
- **Graceful degradation**: a slow/down store never fails a request — the event is
  scored on event-only features and flagged `degraded`.
- **Latency**: model inference p50 ≤ 10 ms (CPU); add one Redis round-trip (~1–3 ms
  in-DC) for the end-to-end single-event budget.
- **Image size**: the default image installs `xgboost`, whose PyPI wheel pulls CUDA
  runtime libs. For a lean CPU-only image, swap to `xgboost-cpu` in the build.

## Offline batch scoring

For backfills / evaluation without the service:

```bash
python -m ml.score_batch --input events.parquet --output scored.parquet
```

Computes engineered features whole-file (matching training) and writes per-event
scores.
