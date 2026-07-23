# Sentinel Fusion AI — Schema v2 Delivery Summary

**Scope:** everything from the initial architecture review to a production-ready
banking integration.
**Baseline:** commit `94c9669` (schema v1).
**Verification:** 222 tests + 46 quality/perf gates + 20 end-to-end tests against
a live Docker + Redis stack. Lint clean. Benchmark regression gate green.

---

## 1. What was asked, and what actually turned out to be wrong

The brief was to improve model intelligence and then productionise it, guided by
`docs/BANK_INTEGRATION_IMPROVEMENTS.md`.

Investigation found the model was not the bottleneck — the **data path** was, in
three compounding ways. Each was measured before anything was changed.

### 1.1 Every dataset's real features were being discarded

`notebooks/src/11_unify.py` built the training corpus as
`[c for c in UNIFIED_COLUMNS if c != "attributes"]`, while `to_unified()` packed
every source's native columns *into* `attributes`:

| source | thrown away |
|---|---|
| creditcard | `V1..V28` — the entire signal |
| paysim | all four balance columns + `nameDest` |
| baf | all 30 Feedzai fields (`credit_risk_score`, `velocity_*`, `device_os`, …) |

The fraud model trained on **15 numerics + `event_type`**. Its 0.838 ROC-AUC was
a plumbing ceiling, not a modelling one.

### 1.2 The history features were structurally dead

| source | rows | distinct users | share with `f_user_seq_no > 0` |
|---|---:|---:|---:|
| baf | 160,800 | 0 | 0.000 |
| creditcard | 150,604 | 0 | 0.000 |
| paysim | 158,265 | **158,262** | **0.000** |

**0% of fraud training rows had any user history**, and all four history features
scored mean |SHAP| of exactly **0.0**.

This falsified §6 of the requirements doc — *"velocity fires natively inside the
fraud model once events stream in"*. It could not. Shipping `/ingest` first, as
originally sequenced, would have fed the model values outside its training
support and made scores **worse**.

### 1.3 `severity` was a perfect label alias, leaking through a derived feature

Agreement of `severity >= 3` with `label == 1`: **1.0000** for baf, beth,
creditcard, paysim and rba. `severity` was correctly excluded from every feature
list — but `f_device_past_hisev_count` is built *from* it, making it a running
count of past confirmed-malicious events, and the **#1 cyber feature** at
mean |SHAP| 4.36.

---

## 2. Results

| model | v1 | v2 |
|---|---:|---:|
| fraud ROC-AUC | 0.8380 | **0.9981** |
| fraud PR-AUC | 0.5359 | **0.8897** |
| fraud F1 | 0.4975 | **0.8314** |
| fusion ROC-AUC | 0.9717 | **0.9811** |
| `cyber` / `quantum` | 0.9975 / 1.0000 | identical *(frozen)* |
| `behaviour` | 0.8167 | 0.7033 *(deliberate — §4)* |

`cyber` and `quantum` reproduced to four decimals across a complete corpus
rebuild, so the fraud gain is attributable rather than incidental.

**Operating point** for `fraud_payment` on 286,170 held-out events at a 0.34%
base rate — the number that matters to a bank:

| band | share of traffic | recall | precision |
|---|---:|---:|---:|
| `critical` | 0.39% | 85.4% | **73.2%** |
| `high` + `critical` | **0.99%** | **94.1%** | 32.0% |
| `low` | 98.64% | — | misses 4.0% of fraud |

**Reviewing ~1% of transactions catches ~94% of fraud.**

---

## 3. What was built

### Data (Phases 1–3)

- **Canonical banking schema** (`docs/canonical_schema.md`) defined by *what the
  bank can actually send*, with datasets mapped into it. Anything a single source
  uniquely has stays out of every model contract.
- **Sparkov acquired** (CC0-1.0): 1.85M transactions, 999 cards, **median 1,471
  txns per card** — the only public source in the corpus with usable
  per-customer sequences. Kept **whole**; sampling it would have reinstated the
  bug it was bought to fix.
- **One feature contract** (`ml/feature_spec.py`) replacing three hand-synced
  copies, fingerprinted by `CONTRACT_HASH`.
- **New banking features**: balance drain ratio, amount-vs-balance, balance
  reconciliation, counterparty novelty + distinct count, merchant-category
  novelty, 1-hour velocity window, geo distance — each with a matching online
  store implementation, proven equal by the parity test.
- **Two leak detectors**: a corpus-level label-alias guard and a per-source
  single-feature AUC audit, both wired into the pipeline.

### Models (Phase 4)

- Fraud split into `fraud_payment` and `fraud_application`. `event_type` had been
  the v1 model's #2 feature — capacity spent recovering that split.
- `behaviour` rebuilt without `country`; `cyber`/`quantum` frozen.
- Risk bands **fitted** per model at stated cost ratios rather than fixed
  constants.

### Service (Phases 5–10)

| Requirement | Delivered |
|---|---|
| §3.1 ingest-only endpoint | `POST /ingest`, `/ingest/batch` → 202, no inference |
| §3.2 idempotent `/score` | `event_id` claim in both backends; exact-replay snapshot |
| §3.3 bank context | Full banking block accepted **and trained on** |
| §4.1 per-group degraded | `degradation{}` separates cold-start from outage |
| §4.2 readable reasons | *"beneficiary was added 5 minutes ago"* |
| §4.3 threshold calibration | Cost-fitted bands; `pick_threshold_cost` wired in |
| §5.1 auth + rate limiting | Named keys, per-client sliding window, 429 + `Retry-After` |
| §5.2 latency SLA + breaker | Circuit breaker, state on `/ready` and in metrics |
| §5.3 feedback loop | `/feedback/batch`; cold-start seeding from bank context |
| §5.4 observability | Per-client, cold-entity, score-distribution, breaker metrics |

---

## 4. Decisions that reduced a headline number on purpose

Three changes made metrics look worse and the system more honest.

**PaySim dropped.** Promoting its balance columns exposed the simulator's own
generating rule — `balance_before == amount AND balance_after == 0` fires on
8,024 rows with **zero false positives** and 97.7% recall. A head trained with it
scored a fake **1.0000**. Real fraudsters do not reliably zero an account.

**creditcard dropped.** Its whole signal is `V1..V28`, PCA components no bank can
reconstruct or send. Under the servability rule only `amount` + timestamp remain.

**`behaviour` 0.8167 → 0.7033.** `country` was its #1 feature at 8× the next, but
RBA's label rate is 0.78 (US) vs 0.10 (NO) — corpus construction, not
account-takeover signal, and a single-country bank sees one constant value.

---

## 5. Bugs found by testing, not by inspection

Each of these was invisible to offline metrics.

| # | Bug | How it surfaced | Impact if shipped |
|---|---|---|---|
| 1 | `f_user_past_malicious_rate` >0 on 54% of training rows but **0%** of live traffic | End-to-end score of an obvious fraud came back **0.0001** | Model suppressed nearly all real fraud |
| 2 | Nanosecond divisor on `datetime64[us]` timestamps | Velocity window never expired — feature was "count of all prior events" | Velocity silently useless |
| 3 | Explainer inverted `DOMAIN_OF_MODEL` | Every financial event explained by the **wrong** head | Analysts shown irrelevant reasons |
| 4 | Redis replay reconstructed approximate pre-state | Replayed `f_amount_z_user` differed once a user had spend history | Documented idempotency guarantee was false |
| 5 | `bank_context_used` never fired for cold users | Store returns `0`, not NaN, so the seed never applied | Bank's signals dropped exactly when they were the only ones available |
| 6 | Two contradictory velocity reasons in one explanation | *"8 transactions"* next to *"2 transactions"* | Analyst feed self-contradicting |
| 7 | FinSpark would be row-sampled at spec volume | Would shatter whole-customer sequences | v1 bug, on the one production-shaped source |

Bugs 4 and 5 were found **only** by running against the real Docker + Redis
stack — every other test runs in-process with an in-memory store.

The label-alias guard also rejected the **first version of my own FinSpark
generator**: it gave every fraud a fresh payee and every benign payment an old
one, making `isNew` a 0.985-balanced-accuracy alias of the target.

---

## 6. The negative result worth keeping

`f_user_past_malicious_rate` was re-tested after implementing label-lag replay
(labels applied at their true confirmation time). It **does not survive**:

| source | mean \| fraud | mean \| benign | with instant labels |
|---|---:|---:|---|
| sparkov | **0.0000** | 0.0031 | 0.107 vs 0.0054 (20×) |
| beth | 0.0000 | 0.0000 | single-feature AUC 0.9977 |

Fraud clusters in time, so by the time a customer's first case is adjudicated the
rest have already happened. The 20× separation was **leakage, not signal**. The
feature stays out.

The lag machinery is retained regardless: it removed a real leak from the frozen
`cyber` model — the per-source audit now flags one feature where it flagged two.

---

## 7. Verification

```bash
make test                              # 222 tests, in-process, hermetic
pytest -m "quality or perf"            # 46 model + latency gates
python -m ml.benchmark --check         # regression gate vs committed baseline
docker compose up -d --build
pytest tests/e2e -m e2e                # 20 tests vs the real shipped image
```

**Measured on the live stack:** `/score` p50 **19.4 ms**, p95 **20.4 ms** over
HTTP + Redis (bank budget ~800 ms). `/ingest` p50 **1.7 ms** — 11× cheaper than
`/score`, which is its entire justification.

The E2E suite is **repeatable** (run twice back to back, 20/20 both times) — the
first version was not, because it reused fixed `event_id`s that the idempotency
guard correctly treated as replays.

---

## 8. Deploy checklist

1. `python -m ml.run_pipeline` — trains all five models, refits bands, stamps
   `CONTRACT_HASH`.
2. `python -m ml.benchmark --check` — must print `gate OK`.
3. `docker compose build` **from the same tree the models were trained in**;
   the service refuses to start on a contract mismatch.
4. Set real secrets: `SENTINEL_API_KEYS="core-banking:$(openssl rand -hex 32)"`,
   and `SENTINEL_RATE_LIMIT_PER_MINUTE` to a real value.
5. Assert `/ready` returns `ready: true`, the expected `contract_hash`, and
   `store_breaker: "closed"`.
6. Alert on `sentinel_degraded_total` (an outage) — **not** on
   `sentinel_cold_entity_total` (new customers, expected).

**Rollback:** point `SENTINEL_MODELS_DIR` at the previous artifacts and restart.
The contract hash makes a mismatched pairing fail loudly at startup instead of
silently mis-scoring.

---

## 9. Open items

| Item | Status |
|---|---|
| `finspark_synth` is in the training corpus as **scaffolding** | Remove from `feature_spec.MODEL_SOURCES` when the real export lands |
| FinSpark export with `label.confirmedAt` | Spec ready at `docs/finspark_export_spec.md`; blocks restoring the malicious-rate feature |
| Band cut points fitted on public + synthetic data | Refit on real bank traffic once available |
| `cyber` retains a known leak (beth AUC 0.9995) | Documented; off the money path. Fix before making any claim about that model |
| mTLS for the banking caller | Not implemented; API-key + per-client rate limiting only |

---

## 10. Reference

| Document | Contents |
|---|---|
| `docs/API.md` | API reference — every example captured from a running instance |
| `docs/MODEL_V1_VS_V2.md` | Full before/after with the measurements behind each claim |
| `docs/canonical_schema.md` | Banking schema, source coverage matrix, licensing |
| `docs/finspark_export_spec.md` | Contract for the bank team |
| `docs/serving.md` | Deployment and integration guide |
| `reports/ml/MODELS.md` | Model report, leak audit, honest caveats |
