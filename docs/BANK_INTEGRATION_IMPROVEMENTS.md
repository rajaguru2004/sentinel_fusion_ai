# Sentinel Fusion AI — Model Improvements for Bank Integration

**Audience:** the model / FastAPI team (`sentinel_fusion_ai`).
**Purpose:** the concrete changes the scoring service needs so the FinSpark bank
simulator can call it in production — not a wish list, only what the integration
actually requires or is blocked by.
**Scope:** model-side only. Bank-side intercept wiring (`HttpScorer`, adapter,
`assess()` call sites) is tracked separately in the bank repo.

---

## 1. Where we are today

- The service exposes `POST /score`, `POST /score/batch`, `POST /feedback`,
  and ops routes (`/health`, `/ready`, `/metrics`).
- `EventIn` follows the unified **security** schema (`event_domain`, tz-aware
  `event_time`, snake_case). Only `event_id` / `event_domain` / `event_time`
  are required; everything else → `NaN` (GBM-safe).
- Four routed models: `fraud` (financial), `cyber`, `behaviour`, `quantum`,
  fused via isotonic calibration → weighted noisy-OR. Risk bands
  `<.25 / .50 / .75` match the bank's decision bands exactly.
- History features (`f_user_seq_no`, `f_user_secs_since_last`, amount moments,
  new-country, device counters) are computed **online** from the Redis feature
  store, and are proven equal to the offline training features by
  `tests/unit/test_feature_parity.py`.

**Integration reality:** only **payment initiation** maps cleanly to a trained
model today. Login → `behaviour` works. Beneficiary events and standalone
velocity have **no dedicated model**. And unless the bank streams events, every
score comes back `degraded` (history = `NaN`), so velocity never fires.

---

## 2. Priorities at a glance

| Tier | Improvement | Why it matters |
|---|---|---|
| **P0** | Ingest-only / context endpoint | Unblocks real velocity + history; makes scores full-fidelity instead of `NaN`-degraded |
| **P0** | Idempotent `/score` (event_id dedup) | Retries must not double-advance feature-store counters |
| **P0** | Consume bank-provided context features | Stop discarding the strong signals the bank already computes |
| **P1** | Per-group `degraded` detail | Bank needs to know *why* a score is weak |
| **P1** | Human-readable SHAP reasons | Analyst feed needs plain language, not `f_log1p_amount` |
| **P1** | Threshold / calibration on bank traffic | Corpus threshold ≠ bank base rate |
| **P2** | Bank-grade auth + rate limiting | Single static key is not production auth |
| **P2** | Latency SLA + circuit breaker | Must fit the bank's ~800 ms budget, fail fast |
| **P2** | Feedback loop wired + cold-start priors | Close the label loop; handle new users/devices |
| **P2** | Observability (degraded / null-rate) | Catch silent degradation in prod |

The three that specifically **unblock** the integration are the P0s.

---

## 3. P0 — required to make the integration work

### 3.1 Ingest-only / context endpoint

**Problem.** `/score` both scores *and* advances the feature store in one call.
The bank has context events (login, beneficiary add/activate, low-value actions)
that should build a user's history/velocity but do **not** need a full verdict on
the request path. With no cheap way to stream them, the store stays empty and
payment scores are permanently degraded (velocity = `NaN`).

**Approach.**
- Add `POST /ingest` (or a `?score=false` flag on `/score`) that runs
  `snapshot_and_advance` on the feature store and returns `202 Accepted` with no
  model inference.
- Make it fire-and-forget friendly: minimal body, fast path, no SHAP.
- Keep the same `event_id` idempotency guard as §3.2 so replays are safe.

**Touch points:** `service/routers/` (new router), `service/feature_service.py`,
`service/store.py`.

**Acceptance:** streaming N context events for a user makes the next `/score`
return `degraded: false` with non-null `f_user_seq_no` / `f_user_secs_since_last`.

### 3.2 Idempotent `/score` (event_id dedup)

**Problem.** `/feedback` is idempotent, but `/score` is not. A network retry of
the same payment **double-advances** velocity, amount moments, and device
counters — corrupting every future score for that entity.

**Approach.**
- Treat `event_id` as an idempotency key. On the store's advance path, record
  processed `event_id`s (TTL-bounded, same pattern as the feedback ledger) and
  skip the counter advance on a repeat, returning the previously computed result
  (or at least not re-advancing state).
- Applies to `/score`, `/score/batch`, and the new `/ingest`.

**Touch points:** `service/store.py` (both `InMemoryStore` and
`RedisFeatureStore` Lua scripts), `service/feature_service.py`.

**Acceptance:** scoring the same `event_id` twice yields identical feature values
and advances counters exactly once.

### 3.3 Consume bank-provided context features

**Problem.** The bank already computes high-signal features —
`beneficiaryAgeMinutes`, `isNewBeneficiary`, `txnCountLastHour`,
`amountVsUserMean`, `nameMismatch`. The model **drops all of them** and
recomputes its own from the store. That both wastes the bank's signals and makes
the model dependent on a warm store for things the bank could hand over directly.

**Approach.**
- Extend `EventIn` with optional passthrough fields for these signals.
- Let the relevant models use them (either as direct features after retrain, or
  as a documented override that seeds the corresponding `f_*` when the store is
  cold — e.g. bank `txnCountLastHour` backstops `f_user_seq_no` velocity).
- Document precedence clearly: store-computed vs bank-provided, and which wins.

**Touch points:** `service/schemas.py`, `service/normalize.py`,
`ml/features.py` / feature contract, model retrain if used as trained features.

**Acceptance:** a payment with `nameMismatch: true` / high `txnCountLastHour`
scores measurably higher than the same payment without, even on a cold store.

---

## 4. P1 — quality of the verdict

### 4.1 Per-group `degraded` detail

Replace the single `degraded` boolean with a breakdown of which feature groups
were unavailable (user history vs device history vs bank-context), so the bank
can decide per case whether to trust the score or fall back to the heuristic.
*Touch:* `service/schemas.py` (`ScoreOut`), `service/feature_service.py`.

### 4.2 Human-readable SHAP reasons

`/score?explain=true` returns internal names (`f_log1p_amount`,
`f_user_seq_no`). Add a mapping/templating layer to emit plain-language reasons
("amount 300× the user's normal", "beneficiary activated 5 min ago") so the
analyst feed and risk badges read like the bank's own heuristic output.
*Touch:* `service/explain.py`, a reason-template table.

### 4.3 Threshold / calibration on bank traffic

Weighted fraud precision at population base rate is ~0.046 — the operating
threshold was chosen on the training corpus, not the bank's distribution.
Provide a way to recalibrate the fraud decision threshold (and, if needed, refit
isotonic) on a sample of real bank traffic once available.
*Touch:* `ml/fusion.py`, `ml/evaluate.py`, threshold config.

---

## 5. P2 — production hardening

### 5.1 Bank-grade auth + rate limiting

Move from one static `SENTINEL_API_KEYS` value to per-client keys, per-key rate
limits, and ideally mTLS for the banking caller. *Touch:* `service/auth.py`,
`service/settings.py`.

### 5.2 Latency SLA + circuit breaker

Guarantee a p99 that fits the bank's ~800 ms client budget; add a circuit breaker
so a slow/dead feature store fails fast to `degraded` rather than hanging the
money path. The store already has a 50 ms timeout — surface it as an explicit SLA
and add breaker state. *Touch:* `service/feature_service.py`,
`tests/perf/test_latency_sla.py`.

### 5.3 Feedback loop + cold-start priors

Confirm `/feedback` actually updates `f_user_past_malicious_rate`; support batch
feedback for backfill. Add sensible priors / an explicit new-entity path so
first-seen users and devices don't score meaninglessly on all-`NaN` history.
*Touch:* `service/store.py`, `ml/feature_core.py`.

### 5.4 Observability

Add per-domain score distributions, a degraded-rate counter alert, and a
feature-null-rate metric to the existing Prometheus registry so silent
degradation is caught in prod. *Touch:* `service/metrics.py`,
`service/routers/score.py`.

---

## 6. What does NOT need a model change

- **Velocity** is already a first-class feature (`f_user_seq_no`,
  `secs_since_last`). Do **not** build a separate velocity score — once events
  stream in (§3.1), velocity fires natively inside the fraud/behaviour models and
  produces one fused, calibrated verdict. Train/serve parity is already
  guaranteed by `test_feature_parity.py`.
- **Login** already maps to the `behaviour` model (trained on risk-based-auth
  account-takeover logins). No new model needed — just the bank-side intercept.

---

## 7. Suggested sequencing

1. **§3.1 + §3.2 together** — the ingest endpoint is pointless without
   idempotency, and idempotency is cheap to add alongside it.
2. **§3.3** — schema passthrough; unblocks cold-store scoring immediately.
3. **§4.1 + §4.2** — makes the analyst feed and degraded handling usable.
4. **§4.3** once real bank traffic exists to calibrate on.
5. **§5.x** as the integration moves toward production.

Ship §3 (all three P0s) first — after that, the bank can integrate and every
score is full-fidelity instead of degraded.
