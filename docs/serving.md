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
| GET  | `/ready` | readiness (503 until scorer loaded + store reachable) |
| POST | `/score` | score one event (`?explain=true` for SHAP) |
| POST | `/score/batch` | score up to `SENTINEL_MAX_BATCH` events |
| POST | `/feedback` | confirm an event's true label (updates risk history) |
| GET  | `/metrics` | Prometheus metrics |

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

### Output fields

- `risk_score` ∈ [0,1], `risk_level` ∈ {low, medium, high, critical}.
- `model` — which specialist scored it; `null` when unscored.
- `contributions` — per-domain calibrated probabilities feeding the fused score.
- `degraded` — `true` if the feature store was unreachable and the event was scored
  on event-only features (still a valid, finite score, just without behavioural
  history). Safe to alert on for observability.
- `explanation` — present only with `?explain=true`: the top SHAP feature
  attributions for the routed model.

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
