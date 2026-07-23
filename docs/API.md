# Sentinel Fusion AI — Risk Scoring API Reference

**Version:** 1.0.0
**Audience:** Banking platform / integration engineers
**Protocol:** HTTP/JSON (REST)
**Default base URL:** `http://<host>:8000`

---

## 1. What this API does

Sentinel Fusion AI scores security and financial events for risk in real time. A
single event is submitted; the service routes it to the appropriate specialist
model, enriches it with the actor's historical behaviour (from an online feature
store), and returns one calibrated **risk score** (`0.0`–`1.0`) and **risk level**
(`low` / `medium` / `high` / `critical`), together with the per-domain
contributions and — on request — a model explanation.

Four specialist models sit behind one endpoint; the caller never chooses a model,
the `event_domain` field routes automatically:

| `event_domain` | Model | Detects |
|---|---|---|
| `financial` | Fraud (XGBoost) | Card / transfer / account-opening fraud |
| `cyber` | Cyber (LightGBM) | Network intrusion, malicious process/flow |
| `behaviour` | Behaviour (LightGBM) | Account takeover, insider anomaly |
| `quantum` | Quantum/HNDL (XGBoost) | Harvest-now-decrypt-later cryptographic risk |
| `threat_intel` | *(none)* | Context only — returned unscored |

Typical integration: call `POST /score` inline in a transaction/authentication
flow, act on `risk_level`, then later confirm the true outcome via `POST /feedback`
so the actor's risk history sharpens over time.

---

## 2. Authentication

All scoring and feedback endpoints require a static API key in a request header:

```
X-API-Key: <your-key>
```

Keys are provisioned per integrating system and supplied out of band. A missing or
unrecognised key returns **HTTP 401**. The operational endpoints (`/health`,
`/ready`, `/metrics`) are unauthenticated.

> **Demo / development key.** For local development and the demo deployment a preset
> key is used:
>
> ```
> X-API-Key: sentinel-demo-key-2026
> ```
>
> It is the built-in default (both the app and `docker-compose.yml`), so
> `docker compose up -d` — or a plain `uvicorn` run — works out of the box.
> **This key is for development only — override it in production** by setting
> `SENTINEL_API_KEYS` (see §2.1). All examples below use this demo key.

### 2.1 Provisioning & rotating API keys

There is no self-service key endpoint by design — keys are **operator-provisioned
secrets**, not user-registerable. The server validates an incoming `X-API-Key`
against a configured allow-list (`SENTINEL_API_KEYS`, comma-separated); a key is
valid iff it is a member of that list.

**1. Generate a strong key** (256-bit random, per consuming system):

```bash
openssl rand -hex 32
# or:  make gen-key
# e.g. 9f2c7b1e5a084d3c6e0b8f4a1d7c2e9b3a6f5c8d0e1b4a7c2f9d6e3b8a1c4f7e
```

Issue **one key per integrating system** (e.g. one for the core banking app, one for
the fraud-ops console) so each can be rotated or revoked independently and traffic is
attributable.

**2. Configure the server** — set the key(s) at deploy time via environment (never in
code or git):

```bash
# single tenant
SENTINEL_API_KEYS="9f2c7b1e...4f7e"

# multiple tenants (comma-separated, no spaces)
SENTINEL_API_KEYS="9f2c7b1e...4f7e,3a6f5c8d...1c4f"
```

With `docker compose`, supply it via the host environment or an `.env` file next to
`docker-compose.yml`:

```
SENTINEL_API_KEYS=9f2c7b1e...4f7e
```

Treat keys as secrets: inject from your secrets manager (Vault / AWS Secrets Manager /
K8s Secret); the repo `.env` is gitignored and must not be committed.

**3. Rotate without downtime** — keys overlap:

1. Generate the new key.
2. Add it **alongside** the old one: `SENTINEL_API_KEYS="OLD,NEW"`; redeploy.
3. Move the calling system to `NEW`.
4. Remove `OLD`: `SENTINEL_API_KEYS="NEW"`; redeploy.

**Revoke** a key by removing it from the list and redeploying.

**Fail-closed:** if `SENTINEL_REQUIRE_AUTH=true` (the default) but no keys are
configured, the scoring endpoints return **HTTP 503** (`{"detail":"authentication not
configured"}`) rather than accepting unauthenticated traffic. `SENTINEL_REQUIRE_AUTH=false`
disables the check entirely and is intended only for isolated local development.

---

## 3. Common request headers

| Header | Required | Value |
|---|---|---|
| `Content-Type` | Yes (POST) | `application/json` |
| `X-API-Key` | Yes (score/feedback) | Provisioned API key |

All timestamps are **ISO-8601, timezone-aware, UTC** (e.g. `2026-07-20T14:05:00Z`).
A naive (no timezone) timestamp is rejected with HTTP 422.

---

## 4. Standard error model

Two error body shapes are returned:

**a) Request validation errors (HTTP 422)** — FastAPI/Pydantic format, a list under
`detail`, one entry per offending field:

```json
{
  "detail": [
    {
      "type": "extra_forbidden",
      "loc": ["body", "foo"],
      "msg": "Extra inputs are not permitted",
      "input": 1
    }
  ]
}
```

**b) Application errors** — a single human-readable string under `detail`:

```json
{ "detail": "invalid or missing X-API-Key" }
```

### HTTP status codes

| Code | Meaning | When |
|---|---|---|
| 200 | OK | Scored / accepted successfully |
| 401 | Unauthorized | Missing or invalid `X-API-Key` |
| 413 | Payload Too Large | Batch exceeds `max_batch` (default 1000) |
| 422 | Unprocessable Content | Body validation failed, or `event_time` too far in the future |
| 501 | Not Implemented | `?explain=true` requested but explanations are disabled |
| 503 | Service Unavailable | Not ready (models loading / store unreachable), or auth not configured |

> **Note on `scored: false`** — a `threat_intel` event, or any domain with no model,
> returns HTTP **200** with `scored: false` and `risk_score: 0.0`. This is a valid,
> expected response, not an error.

---

## 5. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/health` | — | Liveness probe |
| GET  | `/ready` | — | Readiness probe |
| POST | `/score` | ✔ | Score a single event |
| POST | `/score/batch` | ✔ | Score up to `max_batch` events |
| POST | `/feedback` | ✔ | Submit a confirmed label for an event |
| GET  | `/metrics` | — | Prometheus metrics |

---

### 5.1 `GET /health`

Liveness. Always returns 200 while the process is running. Use for load-balancer
liveness checks.

**Request:** no headers, no body.

**Response — 200:**
```json
{ "status": "ok" }
```

---

### 5.2 `GET /ready`

Readiness. Returns 200 only when the models are loaded **and** the feature store is
reachable; otherwise **503** with the same body so you can see which component is
down. Use to gate traffic (e.g. Kubernetes readiness probe).

**Request:** no headers, no body.

**Response — 200 (ready):**
```json
{
  "ready": true,
  "scorer_loaded": true,
  "store_ok": true,
  "model_version": "v1.0.0"
}
```

**Response — 503 (not ready):** same shape with `"ready": false` and whichever of
`scorer_loaded` / `store_ok` is `false`.

---

### 5.3 `POST /score`

Score a single event.

**Headers:** `Content-Type: application/json`, `X-API-Key: <key>`

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `explain` | boolean | `false` | When `true`, include SHAP feature attributions for the routed model |

**Request body — field reference:**

| Field | Type | Required | Description |
|---|---|---|---|
| `event_id` | string | **Yes** | Caller-unique event identifier (echoed back; used for feedback) |
| `event_domain` | enum | **Yes** | `financial` \| `cyber` \| `behaviour` \| `quantum` \| `threat_intel` |
| `event_time` | string (ISO-8601 UTC, tz-aware) | **Yes** | Event timestamp; drives temporal features and history ordering |
| `user_id` | string | No | Actor identifier; enables per-user history features |
| `device_id` | string | No | Device/host identifier; enables per-device history features |
| `event_type` | string | No | Normalised type, e.g. `card_txn`, `network_flow`, `login`, `tls_handshake` |
| `event_subtype` | string | No | Finer classification, e.g. `wire_transfer`, `dns` |
| `country` | string | No | ISO-3166 alpha-2 country of the actor |
| `amount` | number | No | Monetary amount (financial events) |
| `bytes_in` | number | No | Bytes received |
| `bytes_out` | number | No | Bytes sent |
| `src_port` | integer | No | Source port |
| `dst_port` | integer | No | Destination port |
| `protocol` | string | No | `tcp`, `udp`, `icmp`, … |
| `duration_s` | number | No | Session/flow/transaction duration (seconds) |
| `severity` | integer | No | 0–4 severity. **Not a scoring input** — only feeds the device's high-severity history for future events |
| `q_key_exchange` | string | No | (quantum) TLS key-exchange algorithm |
| `q_cert_key_type` | string | No | (quantum) Certificate key type |
| `q_data_class` | string | No | (quantum) Data classification |
| `q_cert_age_days` | number | No | (quantum) Certificate age (days) |
| `q_cert_validity_days` | number | No | (quantum) Certificate validity window (days) |

Rules:
- Only `event_id`, `event_domain`, `event_time` are mandatory. Send whatever else you
  have; **absent fields are handled natively by the models** (they are not an error).
- **Unknown fields are rejected** with HTTP 422 — this protects the contract from
  silent typos. Send only the fields listed above.

**Request example:**
```json
{
  "event_id": "txn-100493",
  "event_domain": "financial",
  "event_time": "2026-07-20T14:05:00Z",
  "event_type": "card_txn",
  "user_id": "cust-8841",
  "amount": 4210.55,
  "country": "GB"
}
```

**Response body — field reference:**

| Field | Type | Description |
|---|---|---|
| `event_id` | string | Echoed from the request |
| `model` | string \| null | Routed model (`fraud`/`cyber`/`behaviour`/`quantum`); `null` if unscored |
| `raw_score` | number \| null | Uncalibrated model score; `null` if unscored |
| `risk_score` | number | Fused risk, `0.0`–`1.0` |
| `risk_level` | enum | `low` \| `medium` \| `high` \| `critical` |
| `scored` | boolean | `false` for uncovered domains (e.g. `threat_intel`) |
| `contributions` | object | Per-domain calibrated probability (`p_fraud`/`p_cyber`/`p_behaviour`/`p_quantum`); `null` where the domain did not fire |
| `model_version` | string | Model/version identifier |
| `degraded` | boolean | `true` if scored without live history (feature store unreachable). Score is still valid, just without behavioural features |
| `explanation` | object \| null | Present only when `?explain=true` (see below) |

Risk-level bands: `low` `[0.00, 0.25)`, `medium` `[0.25, 0.50)`, `high` `[0.50, 0.75)`,
`critical` `[0.75, 1.00]`.

**Response — 200 (financial, scored):**
```json
{
  "event_id": "txn-100493",
  "model": "fraud",
  "raw_score": 0.07999324053525925,
  "risk_score": 0.00483549851924181,
  "risk_level": "low",
  "scored": true,
  "contributions": {
    "p_fraud": 0.00483549851924181,
    "p_cyber": null,
    "p_behaviour": null,
    "p_quantum": null
  },
  "model_version": "v1.0.0",
  "degraded": false,
  "explanation": null
}
```

**Response — 200 (threat_intel, unscored):**
```json
{
  "event_id": "ti-1",
  "model": null,
  "raw_score": null,
  "risk_score": 0.0,
  "risk_level": "low",
  "scored": false,
  "contributions": {
    "p_fraud": null, "p_cyber": null, "p_behaviour": null, "p_quantum": null
  },
  "model_version": "v1.0.0",
  "degraded": false,
  "explanation": null
}
```

#### Explanation (`?explain=true`)

When requested on a scored event, `explanation` contains the top contributing
features for the routed model, each with its value and signed SHAP attribution
(positive pushes risk up, negative pulls it down).

**Request:** `POST /score?explain=true` with a `cyber` event.

**Response — 200 (truncated to show shape):**
```json
{
  "event_id": "evt-cyber-77",
  "model": "cyber",
  "raw_score": 0.9745387920363321,
  "risk_score": 0.9922480620155039,
  "risk_level": "critical",
  "scored": true,
  "contributions": { "p_fraud": null, "p_cyber": 0.9922480620155039, "p_behaviour": null, "p_quantum": null },
  "model_version": "v1.0.0",
  "degraded": false,
  "explanation": {
    "model": "cyber",
    "top_features": [
      { "feature": "f_device_past_hisev_count", "value": 0.0,    "shap": -6.479  },
      { "feature": "f_user_secs_since_last",     "value": 60.0,   "shap": 3.0517  },
      { "feature": "dst_port",                   "value": 4444.0, "shap": 2.7076  },
      { "feature": "f_user_past_malicious_rate", "value": 0.0,    "shap": -2.6152 },
      { "feature": "f_device_seq_no",            "value": 0.0,    "shap": 2.0828  },
      { "feature": "bytes_out",                  "value": 9000.0, "shap": -0.312  },
      { "feature": "duration_s",                 "value": null,   "shap": -0.261  }
    ]
  }
}
```

`explanation.top_features[].value` may be `null` when the underlying feature was not
provided for that event.

**Error responses for `/score`:**

- **401** — missing/invalid key: `{ "detail": "invalid or missing X-API-Key" }`
- **422** — unknown field:
  ```json
  { "detail": [ { "type": "extra_forbidden", "loc": ["body","foo"], "msg": "Extra inputs are not permitted", "input": 1 } ] }
  ```
- **422** — naive timestamp:
  ```json
  { "detail": [ { "type": "value_error", "loc": ["body","event_time"], "msg": "Value error, event_time must be timezone-aware (UTC)", "input": "2026-07-20T14:05:00", "ctx": { "error": {} } } ] }
  ```
- **422** — missing required fields:
  ```json
  { "detail": [ { "type": "missing", "loc": ["body","event_domain"], "msg": "Field required", "input": { "event_id": "x" } }, { "type": "missing", "loc": ["body","event_time"], "msg": "Field required", "input": { "event_id": "x" } } ] }
  ```
- **422** — event too far in the future (clock-skew guard, default 300s):
  ```json
  { "detail": "event_time is 30687351843s in the future" }
  ```
- **501** — `?explain=true` while explanations disabled: `{ "detail": "explanations disabled" }`

---

### 5.4 `POST /score/batch`

Score multiple events in one call. Results are returned **in request order**. Up to
`max_batch` events (default 1000).

**Headers:** `Content-Type: application/json`, `X-API-Key: <key>`
**Query parameters:** `explain` (boolean, default `false`) — as for `/score`.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `events` | array of Event objects | **Yes** | 1..`max_batch` events; each object is exactly the `/score` body |

```json
{
  "events": [
    { "event_id": "txn-100493", "event_domain": "financial", "event_time": "2026-07-20T14:05:00Z", "event_type": "card_txn", "user_id": "cust-8841", "amount": 4210.55, "country": "GB" },
    { "event_id": "ti-1", "event_domain": "threat_intel", "event_time": "2026-07-20T14:08:00Z", "event_type": "ioc_ip" }
  ]
}
```

**Response — 200:**
```json
{
  "results": [
    {
      "event_id": "txn-100493",
      "model": "fraud",
      "raw_score": 0.07218026369810104,
      "risk_score": 0.00483549851924181,
      "risk_level": "low",
      "scored": true,
      "contributions": { "p_fraud": 0.00483549851924181, "p_cyber": null, "p_behaviour": null, "p_quantum": null },
      "model_version": "v1.0.0",
      "degraded": false,
      "explanation": null
    },
    {
      "event_id": "ti-1",
      "model": null,
      "raw_score": null,
      "risk_score": 0.0,
      "risk_level": "low",
      "scored": false,
      "contributions": { "p_fraud": null, "p_cyber": null, "p_behaviour": null, "p_quantum": null },
      "model_version": "v1.0.0",
      "degraded": false,
      "explanation": null
    }
  ]
}
```

**Error responses:**
- **422** — empty `events` array, or any event fails validation (same shapes as `/score`).
- **413** — batch exceeds the limit: `{ "detail": "batch exceeds max_batch=1000" }`

> Ordering note: events for the same `user_id` in one batch are advanced through the
> feature store in `event_time` order internally, so history features are consistent
> regardless of array order.

---

### 5.5 `POST /feedback`

Submit the confirmed outcome (true label) for a previously scored event. This
updates the user's malicious-history counter (`f_user_past_malicious_rate`), so
future scores for that user reflect confirmed incidents. Idempotent per `event_id`.

**Headers:** `Content-Type: application/json`, `X-API-Key: <key>`

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `event_id` | string | **Yes** | The event's original `event_id` (deduplication key) |
| `user_id` | string | **Yes** | The event's `user_id` |
| `label` | integer | **Yes** | `1` = confirmed malicious/fraud, `0` = confirmed benign |

```json
{ "event_id": "txn-100493", "user_id": "cust-8841", "label": 1 }
```

**Response — 200 (first submission):**
```json
{ "event_id": "txn-100493", "applied": true }
```

**Response — 200 (duplicate `event_id`, ignored):**
```json
{ "event_id": "txn-100493", "applied": false }
```

**Error responses:**
- **401** — missing/invalid key.
- **422** — missing field or `label` not in `{0, 1}`.

---

### 5.6 `GET /metrics`

Prometheus exposition (text format) for scrapers. Unauthenticated.

Exposed series include:
- `sentinel_score_latency_seconds` — end-to-end scoring latency histogram (`endpoint` label)
- `sentinel_scored_total` — events scored (`model`, `risk_level` labels)
- `sentinel_degraded_total` — events scored without live feature-store state
- `sentinel_feedback_total` — feedback events applied (`applied` label)

---

## 6. Integration notes

- **Idempotency of scoring:** scoring **advances** the actor's history, so submitting
  the same event twice counts it twice. Submit each real event once. `/feedback` is
  the idempotent endpoint (deduped by `event_id`).
- **`degraded: true`:** the feature store was briefly unreachable and the event was
  scored on event-only features. The response is still valid and finite; treat a
  sustained rise in `degraded` as an operational alert, not a per-request failure.
- **Latency:** model inference p50 ≤ 10 ms (CPU); add one feature-store round trip
  (~1–3 ms in-datacentre) for the end-to-end single-event budget. `?explain=true`
  adds tens of milliseconds and should be used for case review, not the hot path.
- **Versioning:** the `model_version` in every response identifies the deployed model
  build. Log it alongside decisions for auditability.
- **Time source:** `event_time` drives temporal and recency features and the ordering
  of an actor's history. Send accurate UTC timestamps; events more than 300 s in the
  future are rejected (configurable) to guard against clock skew / replay.

---

## 7. Quick reference (curl)

```bash
# Score
curl -sS http://<host>:8000/score \
  -H "X-API-Key: sentinel-demo-key-2026" -H "Content-Type: application/json" \
  -d '{"event_id":"txn-1","event_domain":"financial","event_time":"2026-07-20T14:05:00Z","event_type":"card_txn","user_id":"cust-8841","amount":4210.55,"country":"GB"}'

# Score with explanation
curl -sS "http://<host>:8000/score?explain=true" -H "X-API-Key: sentinel-demo-key-2026" \
  -H "Content-Type: application/json" -d '{ ...event... }'

# Batch
curl -sS http://<host>:8000/score/batch -H "X-API-Key: sentinel-demo-key-2026" \
  -H "Content-Type: application/json" -d '{"events":[ {...}, {...} ]}'

# Feedback
curl -sS http://<host>:8000/feedback -H "X-API-Key: sentinel-demo-key-2026" \
  -H "Content-Type: application/json" \
  -d '{"event_id":"txn-1","user_id":"cust-8841","label":1}'

# Health / readiness
curl -sS http://<host>:8000/health
curl -sS http://<host>:8000/ready
```

An interactive OpenAPI/Swagger UI is also served at `http://<host>:8000/docs`.
