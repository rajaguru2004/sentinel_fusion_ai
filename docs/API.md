# Sentinel Fusion AI — Risk Scoring API Reference

**Schema version:** v2
**Audience:** Banking platform / integration engineers
**Protocol:** HTTP/JSON (REST)
**Default base URL:** `http://<host>:8000`

Every example response in this document was captured from a running instance.

---

## 1. What this API does

Sentinel Fusion AI scores banking and security events for risk in real time. An
event is submitted; the service routes it to a specialist model, enriches it with
the actor's history from an online feature store, and returns one calibrated
**risk score** (`0.0`–`1.0`), a **risk level**, per-model contributions and —
on request — an explanation in plain language.

The caller never picks a model. Routing is automatic on
`(event_domain, event_type)`:

| `event_domain` | `event_type` | Model | Detects |
|---|---|---|---|
| `financial` | `account_open` | `fraud_application` | Account-opening fraud |
| `financial` | anything else | `fraud_payment` | Payment / card fraud |
| `cyber` | — | `cyber` | Network intrusion, malicious process/flow |
| `behaviour` | — | `behaviour` | Account takeover, insider anomaly |
| `quantum` | — | `quantum` | Harvest-now-decrypt-later cryptographic risk |
| `threat_intel` | — | *(none)* | Context only — returned unscored |

> **Changed in v2.** The single `fraud` model was split into `fraud_payment` and
> `fraud_application`. `model` in the response now returns those names, and
> `contributions` gained `p_fraud_payment` / `p_fraud_application`. `p_fraud` is
> kept as a **deprecated** mirror of whichever fraud head fired, so an existing
> client keeps working without a coordinated release.

### Typical integration

```
beneficiary added / login / balance check  ->  POST /ingest      (202, no score)
payment initiated / card purchase          ->  POST /score       (act on risk_level)
chargeback / SOC adjudication              ->  POST /feedback
```

**Stream the context events.** `/ingest` builds the customer's history without
paying for model inference. Without it the feature store stays empty, every
payment scores with `degradation.user_history: true`, and velocity features never
fire.

---

## 2. Authentication

All scoring, ingest and feedback endpoints require an API key header:

```
X-API-Key: <your-key>
```

`/health`, `/ready` and `/metrics` are unauthenticated (for orchestrators).

> **Demo key.** `sentinel-demo-key-2026` is the built-in default so
> `docker compose up -d` works out of the box. **Development only — override in
> production** via `SENTINEL_API_KEYS`.

### 2.1 Named keys, per-client rate limiting

Keys are **named**, so traffic is attributable and one integration can be
throttled or revoked without touching the others:

```bash
# named (recommended)
SENTINEL_API_KEYS="core-banking:9f2c7b1e...,fraud-ops:3a6f5c8d..."

# unnamed (legacy) — clients are auto-named client-1, client-2, ...
SENTINEL_API_KEYS="9f2c7b1e...,3a6f5c8d..."
```

Only the **first** `:` separates name from key, so a key may itself contain `:`.

Generate a strong key per integrating system:

```bash
openssl rand -hex 32     # or: make gen-key
```

Rate limiting is **per client**, not global:

```bash
SENTINEL_RATE_LIMIT_PER_MINUTE=600     # 0 (default) disables it
```

Exceeding it returns **429** with a `Retry-After` header. A noisy client cannot
throttle anyone else. Per-client volume is exported as
`sentinel_requests_total{client=...}`.

**Rotation without downtime:** add the new key alongside the old
(`"core:OLD,core-new:NEW"`), migrate the caller, then remove the old one.

**Fail-closed:** if `SENTINEL_REQUIRE_AUTH=true` (default) but no keys are
configured, scoring endpoints return **503**, never unauthenticated traffic.
Keys are compared with `secrets.compare_digest` (constant time).

---

## 3. Common request headers

| Header | Required | Value |
|---|---|---|
| `Content-Type` | Yes (POST) | `application/json` |
| `X-API-Key` | Yes (score/ingest/feedback) | Provisioned API key |

All timestamps are **ISO-8601, timezone-aware, UTC**. A naive timestamp is
rejected with 422.

---

## 4. Errors

**Validation errors (422)** — FastAPI/Pydantic list under `detail`:

```json
{ "detail": [ { "type": "extra_forbidden", "loc": ["body","foo"],
                "msg": "Extra inputs are not permitted", "input": 1 } ] }
```

**Application errors** — a single string under `detail`:

```json
{ "detail": "invalid or missing X-API-Key" }
```

| Code | Meaning | When |
|---|---|---|
| 200 | OK | Scored / accepted |
| 202 | Accepted | `/ingest` — state advanced, no score returned |
| 401 | Unauthorized | Missing or invalid `X-API-Key` |
| 413 | Payload Too Large | Batch exceeds `max_batch` (default 1000) |
| 422 | Unprocessable Content | Body validation failed, or `event_time` too far in the future |
| 429 | Too Many Requests | Per-client rate limit exceeded (`Retry-After` header) |
| 501 | Not Implemented | `?explain=true` while explanations are disabled |
| 503 | Service Unavailable | Not ready, or auth required but unconfigured |

> `scored: false` (e.g. `threat_intel`) is **HTTP 200**, not an error.

---

## 5. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/health` | — | Liveness |
| GET  | `/ready` | — | Readiness + contract hash + breaker state |
| POST | `/score` | ✔ | Score one event |
| POST | `/score/batch` | ✔ | Score up to `max_batch` events |
| POST | `/ingest` | ✔ | Build history **without** scoring |
| POST | `/ingest/batch` | ✔ | Bulk context events |
| POST | `/feedback` | ✔ | Confirmed label for one event |
| POST | `/feedback/batch` | ✔ | Bulk adjudication backfill |
| GET  | `/metrics` | — | Prometheus metrics |

---

### 5.1 `GET /health`

Liveness; always 200 while the process runs.

```json
{ "status": "ok" }
```

### 5.2 `GET /ready`

200 only when models are loaded **and** the store is reachable; otherwise 503
with the same shape.

```json
{
  "ready": true,
  "scorer_loaded": true,
  "store_ok": true,
  "model_version": "dev",
  "contract_hash": "ec65b4e5353c0928",
  "store_breaker": "closed"
}
```

| Field | Meaning |
|---|---|
| `contract_hash` | Fingerprint of the feature contract the loaded models were trained under. The service **refuses to start** if code and artifacts disagree — use this in a deploy check. |
| `store_breaker` | `closed` healthy · `degraded` recent faults · `open` store calls are being skipped (§6) |

---

### 5.3 `POST /score`

**Query:** `explain` (bool, default `false`).

#### Required fields

| Field | Type | Description |
|---|---|---|
| `event_id` | string | Caller-unique. **Idempotency key** — see §6 |
| `event_domain` | enum | `financial` \| `cyber` \| `behaviour` \| `quantum` \| `threat_intel` |
| `event_time` | ISO-8601 UTC, tz-aware | Drives temporal features and history ordering |

Everything else is optional; absent fields are handled natively by the models.
**Unknown fields are rejected with 422**, which protects the contract from typos.

#### Core optional fields

`user_id`, `device_id`, `event_type`, `event_subtype`, `country`, `amount`,
`bytes_in`, `bytes_out`, `src_port`, `dst_port`, `protocol`, `duration_s`,
`severity`.

> `severity` is **not** a scoring input. It only feeds a device's high-severity
> history for future events.

#### Banking fields (new in v2)

These are **trained features** of `fraud_payment` — sending them materially
changes the score. v1 rejected them outright.

| Group | Fields |
|---|---|
| Counterparty | `counterparty_id`, `counterparty_country`, `counterparty_is_new`, `counterparty_age_s`, `name_mismatch`, `counterparty_lat`, `counterparty_lon` |
| Balances | `balance_before`, `balance_after`, `counterparty_balance_before`, `counterparty_balance_after` |
| Customer | `customer_age`, `account_age_s`, `income`, `email_is_free` |
| Channel/device | `channel`, `device_os`, `device_is_new`, `session_length_s`, `is_foreign_request` |
| Merchant / geo | `merchant_id`, `merchant_category`, `geo_lat`, `geo_lon` |
| Transaction | `currency`, `payment_type`, `is_credit` |
| Quantum | `q_key_exchange`, `q_cert_key_type`, `q_data_class`, `q_cert_age_days`, `q_cert_validity_days` |

#### Bank-computed block

Map straight from FinSpark's own fields:

| Send | From |
|---|---|
| `bank_txn_count_1h` | `txnCountLastHour` |
| `bank_amount_vs_user_mean` | `amountVsUserMean` |
| `bank_beneficiary_age_s` | `beneficiaryAgeMinutes` × 60 |
| `bank_is_new_beneficiary` | `isNewBeneficiary` |

**Precedence:** a store-computed feature wins whenever available; the `bank_*`
value seeds the equivalent when the store is cold. Send both — they are also
independent trained features, and they are what makes a first-ever payment score
on real signal instead of empty history.

#### Request

```json
{
  "event_id": "txn-bad",
  "event_domain": "financial",
  "event_type": "card_txn",
  "event_time": "2026-07-09T13:20:00Z",
  "user_id": "cust-8841",
  "amount": 9000.0,
  "country": "GB",
  "channel": "pos",
  "currency": "GBP",
  "is_credit": 0,
  "merchant_category": "shopping_net",
  "counterparty_id": "brand-new",
  "counterparty_age_s": 300,
  "name_mismatch": 1,
  "bank_txn_count_1h": 8
}
```

#### Response fields

| Field | Type | Description |
|---|---|---|
| `event_id` | string | Echoed |
| `model` | string \| null | `fraud_payment`, `fraud_application`, `cyber`, `behaviour`, `quantum`; `null` if unscored |
| `raw_score` | number \| null | Uncalibrated model output |
| `risk_score` | number | Fused, **calibrated probability** `0.0`–`1.0` |
| `risk_level` | enum | `low` \| `medium` \| `high` \| `critical` |
| `scored` | boolean | `false` for uncovered domains |
| `contributions` | object | Per-model calibrated probability; `null` where that model did not fire |
| ↳ | | `p_fraud_payment`, `p_fraud_application`, `p_cyber`, `p_behaviour`, `p_quantum`, and the deprecated `p_fraud` |
| `model_version` | string | Deployed build identifier — log it with every decision |
| `degraded` | boolean | **Deprecated** mirror of `degradation.degraded` |
| `degradation` | object | Per-group breakdown — see below |
| `explanation` | object \| null | Only with `?explain=true` |

#### `degradation` (new in v2)

A single boolean could not distinguish "brand-new customer" from "Redis is
down"; those need different responses from the bank.

| Field | Meaning | What to do |
|---|---|---|
| `store_unavailable` | Feature store timed out or errored | **Alert.** Consider your heuristic fallback |
| `user_history` | No prior events for this customer | Normal for a new customer — stream `/ingest` |
| `device_history` | No prior events for this device | Normal for a new device |
| `bank_context_used` | A `bank_*` value filled a missing feature | Informational |
| `degraded` | Any of the above | Legacy summary |

#### Response — normal payment (verified)

```json
{
  "event_id": "txn-ok",
  "model": "fraud_payment",
  "raw_score": 0.005160215310752392,
  "risk_score": 0.000039912589272717,
  "risk_level": "low",
  "scored": true,
  "contributions": {
    "p_fraud": 0.000039912589272717,
    "p_fraud_payment": 0.000039912589272717,
    "p_fraud_application": null,
    "p_cyber": null, "p_behaviour": null, "p_quantum": null
  },
  "model_version": "dev",
  "degraded": false,
  "degradation": {
    "degraded": false, "store_unavailable": false,
    "user_history": false, "device_history": false,
    "bank_context_used": false
  },
  "explanation": null
}
```

#### Response — fraud-shaped payment, `?explain=true` (verified)

```json
{
  "event_id": "txn-bad",
  "model": "fraud_payment",
  "raw_score": 0.9982006549835205,
  "risk_score": 1.0,
  "risk_level": "critical",
  "scored": true,
  "contributions": { "p_fraud": 1.0, "p_fraud_payment": 1.0,
                     "p_fraud_application": null, "p_cyber": null,
                     "p_behaviour": null, "p_quantum": null },
  "model_version": "dev",
  "degraded": false,
  "degradation": { "degraded": false, "store_unavailable": false,
                   "user_history": false, "device_history": false,
                   "bank_context_used": false },
  "explanation": {
    "model": "fraud_payment",
    "top_features": [
      { "feature": "amount",                         "value": 9000.0, "shap": 3.2719 },
      { "feature": "bank_txn_count_1h",              "value": 8.0,    "shap": 1.5790 },
      { "feature": "f_log1p_amount",                 "value": 9.1051, "shap": 0.9195 },
      { "feature": "f_hour_cos",                     "value": 0.8660, "shap": 0.7784 },
      { "feature": "customer_age",                   "value": 41.0,   "shap": -0.6590 },
      { "feature": "merchant_category",              "value": 11.0,   "shap": -0.6575 },
      { "feature": "f_user_distinct_counterparties", "value": 3.0,    "shap": 0.5377 }
    ],
    "reasons": [
      "8 transactions by this customer in the past hour",
      "beneficiary was added 5 minutes ago",
      "amount is far outside this customer's usual range",
      "first ever payment to this beneficiary"
    ]
  }
}
```

`explanation.reasons` is the analyst-facing view — use it for case queues and
risk badges; `top_features` is the machine-readable SHAP view. **`reasons` is
empty when nothing notable fired**: benign traffic gets no invented narrative.

`?explain=true` costs tens of milliseconds. Use it for case review, not the hot
path.

---

### 5.4 Risk bands

`risk_score` is a **genuine calibrated probability**, so at a real fraud base
rate (~0.3%) even a strong signal sits well below 0.25. Fixed 0.25/0.50/0.75
cut points would therefore report almost everything as `low`.

Bands are instead **fitted per model**, each edge being the cost-optimal
threshold at a stated cost ratio (`c_fn/c_fp` = 60 / 20 / 5), so every boundary
maps to a business trade-off. Current deployed cut points:

| model | low → medium | medium → high | high → critical |
|---|---:|---:|---:|
| `fraud_payment` | 0.0138 | 0.0396 | 0.2430 |
| `fraud_application` | 0.0922 | 0.2760 | 0.6471 |
| `cyber` | 0.0069 | 0.1559 | 0.1837 |
| `behaviour` | 0.0574 | 0.1148 | 0.4074 |
| `quantum` | 0.25 | 0.50 | 0.75 |

**Do not hardcode these.** They are refitted on every retrain and travel in
`models/fusion_engine.joblib`. Band on `risk_level`; use `risk_score` for
ranking, audit and monitoring.

Measured operating point for `fraud_payment` (286,170 held-out events, 0.34%
base rate):

| band | share of traffic | recall | precision |
|---|---:|---:|---:|
| `critical` | 0.39% | 85.4% | 73.2% |
| `high` + `critical` | **0.99%** | **94.1%** | 32.0% |
| `low` | 98.64% | — | misses 4.0% of fraud |

Reviewing ~1% of transactions catches ~94% of fraud.

---

### 5.5 `POST /score/batch`

Up to `max_batch` events (default 1000); results returned **in request order**.

```json
{ "events": [ { "...event..." }, { "...event..." } ] }
```

Response: `{ "results": [ ScoreOut, ... ] }`.

Events for the same `user_id` are advanced through the feature store in
`event_time` order internally, so history is consistent regardless of array
order.

- **413** — `{ "detail": "batch exceeds max_batch=1000" }`
- **422** — empty `events`, or any event fails validation

---

### 5.6 `POST /ingest` and `POST /ingest/batch`

Advance the customer's history **without** running the model. Returns **202**.
Cheaper than `/score` (no inference, no SHAP) and safe to fire-and-forget.

Body is exactly the `/score` body (`/ingest`) or `{"events":[...]}`
(`/ingest/batch`).

```json
{ "accepted": 12, "rejected": 0 }
```

`rejected` counts events whose state could not be advanced because the store was
unavailable. They are safe to retry — the `event_id` guard makes a duplicate a
no-op.

**Send here:** beneficiary add/activate, balance check, statement view, and any
low-value action that should build history but needs no verdict.

---

### 5.7 `POST /feedback` and `POST /feedback/batch`

Record the confirmed outcome of an event. Idempotent per `event_id`.

```json
{ "event_id": "txn-100493", "user_id": "cust-8841", "label": 1 }
```
```json
{ "event_id": "txn-100493", "applied": true }
```

`applied: false` means the `event_id` was already recorded.

Batch form takes `{"items":[ ... ]}` and returns:

```json
{ "results": [ {"event_id":"fb-a","applied":true} ], "applied": 2, "duplicates": 0 }
```

> **Scope note.** The feature this loop feeds (`f_user_past_malicious_rate`) is
> **not currently a model input**. Measured with realistic confirmation lag its
> discriminative power vanishes (0.0000 on fraud vs 0.0031 on benign) — its
> apparent value came from assuming labels arrive instantly. Keep posting
> feedback: the counters accumulate, so the feature can be restored once real
> `confirmedAt` timestamps are available. See `reports/ml/MODELS.md`.

---

### 5.8 `GET /metrics`

Prometheus exposition. Series:

| Metric | Labels | Use |
|---|---|---|
| `sentinel_score_latency_seconds` | `endpoint` | Latency histogram |
| `sentinel_scored_total` | `model`, `risk_level` | Score volume + band mix |
| `sentinel_risk_score` | `model` | Score distribution (drift) |
| `sentinel_ingested_total` | — | Context events streamed |
| `sentinel_degraded_total` | — | **Store unavailable** — alert on a rise |
| `sentinel_cold_entity_total` | `entity` | New customers/devices (expected, not an incident) |
| `sentinel_requests_total` | `client`, `endpoint` | Per-client traffic |
| `sentinel_rate_limited_total` | `client` | Throttled clients |
| `sentinel_store_breaker_open` | — | `1` while store calls are being skipped |
| `sentinel_feedback_total` | `applied` | Feedback loop health |

`degraded_total` and `cold_entity_total` are deliberately separate: a new
customer is normal, an unreachable store is an incident.

---

## 6. Integration notes

- **Idempotency (changed in v2).** `event_id` is now the idempotency key for
  `/score`, `/score/batch` and `/ingest`. A retry returns the same features and
  advances counters **exactly once**. In v1 a retry double-counted velocity and
  corrupted every later score for that customer. **Retry freely.**
- **Circuit breaker.** After `SENTINEL_BREAKER_FAIL_THRESHOLD` consecutive store
  faults (default 5) the service stops calling the store for
  `SENTINEL_BREAKER_RESET_S` (default 10s) and degrades immediately, so a dead
  store cannot burn the timeout on every request. State is on `/ready` and in
  `sentinel_store_breaker_open`.
- **Latency.** Model inference p50 ≤ 2.6 ms (CPU) plus one store round trip
  (~1–3 ms in-DC); the store call is capped at `SENTINEL_STORE_TIMEOUT_MS`
  (default 50 ms), so a single `/score` fits comfortably in an ~800 ms client
  budget even when degrading.
- **Contract hash.** `/ready` reports `contract_hash`; the service refuses to
  start when code and model artifacts disagree. Assert it in your deploy check.
- **Time source.** `event_time` drives temporal and recency features and history
  ordering. Events more than 300 s in the future are rejected (configurable).

---

## 7. Configuration (env, prefix `SENTINEL_`)

| Var | Default | Meaning |
|---|---|---|
| `SENTINEL_MODELS_DIR` | `<repo>/models` | Trained bundle location |
| `SENTINEL_MODEL_VERSION` | `dev` | Version echoed in responses |
| `SENTINEL_API_KEYS` | demo key | `name:key` pairs, comma-separated |
| `SENTINEL_REQUIRE_AUTH` | `true` | `false` only for local dev |
| `SENTINEL_RATE_LIMIT_PER_MINUTE` | `0` | Per-client limit; 0 disables |
| `SENTINEL_REDIS_URL` | — | e.g. `redis://redis:6379/0`; unset → in-memory |
| `SENTINEL_STATE_TTL_SECONDS` | 90d | Per-entity retention |
| `SENTINEL_STORE_TIMEOUT_MS` | 50 | Per-request store budget |
| `SENTINEL_BREAKER_FAIL_THRESHOLD` | 5 | Faults before the circuit opens |
| `SENTINEL_BREAKER_RESET_S` | 10 | Seconds before a retry probe |
| `SENTINEL_MAX_BATCH` | 1000 | Batch size cap |
| `SENTINEL_ENABLE_EXPLAIN` | `true` | Allow `?explain=true` |
| `SENTINEL_REJECT_FUTURE_EVENTS_SECONDS` | 300 | Clock-skew guard |

---

## 8. Quick reference (curl)

```bash
KEY="sentinel-demo-key-2026"

# Stream context (no score, 202)
curl -sS http://localhost:8000/ingest -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"event_id":"ctx-1","event_domain":"financial","event_type":"balance_check",
       "event_time":"2026-07-09T13:00:00Z","user_id":"cust-8841"}'

# Score a payment
curl -sS http://localhost:8000/score -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"event_id":"txn-1","event_domain":"financial","event_type":"card_txn",
       "event_time":"2026-07-09T13:20:00Z","user_id":"cust-8841","amount":4210.55,
       "country":"GB","counterparty_id":"bene-9","counterparty_age_s":300,
       "name_mismatch":1,"bank_txn_count_1h":7}'

# With plain-language reasons
curl -sS "http://localhost:8000/score?explain=true" -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{ ...event... }'

# Feedback
curl -sS http://localhost:8000/feedback -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"event_id":"txn-1","user_id":"cust-8841","label":1}'

# Ops
curl -sS http://localhost:8000/health
curl -sS http://localhost:8000/ready
curl -sS http://localhost:8000/metrics
```

Interactive OpenAPI/Swagger UI: `http://<host>:8000/docs`.
