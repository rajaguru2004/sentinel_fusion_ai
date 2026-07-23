# Sentinel Fusion AI — v1 vs v2 Model Report

**v1** = commit `94c9669` (schema v1 corpus, single fraud model).
**v2** = current (`ml/feature_spec.py` contract, banking schema, two fraud heads).
Both measured by `python -m ml.run_pipeline` on the same box, seed 42, CPU-only.

---

## 1. Headline

| model | ROC-AUC | PR-AUC | F1 | Precision | Recall |
|---|---:|---:|---:|---:|---:|
| **v1 `fraud`** | 0.8380 | 0.5359 | 0.4975 | 0.5101 | 0.4855 |
| **v2 `fraud_payment`** | **0.9981** | **0.8897** | **0.8314** | **0.8629** | **0.8021** |
| **v2 `fraud_application`** *(new head)* | 0.7927 | 0.3469 | 0.3814 | 0.3575 | 0.4086 |
| v1 `cyber` | 0.9975 | 0.9961 | 0.9620 | 0.9552 | 0.9690 |
| v2 `cyber` *(frozen)* | 0.9975 | 0.9961 | 0.9620 | 0.9552 | 0.9690 |
| v1 `behaviour` | 0.8167 | 0.7922 | 0.8285 | 0.7326 | 0.9531 |
| v2 `behaviour` *(rebuilt)* | 0.7033 | 0.7144 | 0.7476 | 0.6310 | 0.9168 |
| v1 `quantum` | 1.0000 | 0.9999 | 0.9958 | 0.9916 | 1.0000 |
| v2 `quantum` *(frozen)* | 1.0000 | 0.9999 | 0.9958 | 0.9916 | 1.0000 |
| v1 fusion | 0.9717 | | | | |
| v2 fusion | **0.9811** | | | | |

`cyber` and `quantum` reproduce v1 to 4 decimal places across a complete corpus
rebuild — the freeze held, so the fraud/behaviour changes are attributable.

**Fraud on the bank's money path: ROC-AUC +0.160, PR-AUC +0.334, F1 +0.309.**
`behaviour` got worse deliberately (§5).

---

## 2. Why v1 scored 0.838 — it was not the model

Three defects in the data path, all measured:

### 2.1 Every dataset's real features were discarded

`notebooks/src/11_unify.py` built the training corpus as
`[c for c in UNIFIED_COLUMNS if c != "attributes"]`, and `prep_utils.to_unified`
packs each source's native columns *into* `attributes`. So:

| source | discarded | 
|---|---|
| creditcard | `V1..V28` — the entire signal |
| paysim | `oldbalanceOrg`, `newbalanceOrig`, `oldbalanceDest`, `newbalanceDest`, `nameDest` |
| baf | all 30 Feedzai fields (`credit_risk_score`, `velocity_6h/24h/4w`, `device_os`, `email_is_free`, `foreign_request`, `phone_*_valid`, …) |

The v1 fraud model trained on **15 numerics + `event_type`**.

### 2.2 The history features were dead

Measured on the v1 engineered corpus:

| source | rows | `user_id` | distinct users | share with `f_user_seq_no > 0` |
|---|---:|---:|---:|---:|
| baf | 160,800 | none | 0 | 0.000 |
| creditcard | 150,604 | none | 0 | 0.000 |
| paysim | 158,265 | present | **158,262** | **0.000** |

**0% of fraud training rows carried any user history.** `reports/ml/shap_fraud_top_features.json`
at v1 confirms it — mean |SHAP| **exactly 0.0** for all four:

```
f_amount_ratio_mean         0.0
f_user_past_malicious_rate  0.0
f_user_secs_since_last      0.0
f_amount_z_user             0.0
```

This falsifies §6 of `BANK_INTEGRATION_IMPROVEMENTS.md` ("velocity fires natively
inside the fraud model once events stream in"). It could not. Shipping `/ingest`
against the v1 model would have fed it values outside its training support.

Root cause was **row-level sampling**, which shatters per-entity sequences — plus
PaySim being sequence-free by construction (1.0 events/user even at full 6.36M).

### 2.3 `severity` was a perfect label alias, leaking through a derived feature

Agreement of `severity >= 3` with `label == 1`:

```
baf 1.0000  beth 1.0000  creditcard 1.0000  paysim 1.0000  rba 1.0000
cicids2017 0.9965  quantum_synth 0.9791
```

`severity` was correctly excluded from every feature list — but
`ml/feature_core.py::advance_device` builds `f_device_past_hisev_count` from it,
making it a running count of past *confirmed-malicious* events. It was v1
`cyber`'s **#1 feature at mean |SHAP| 4.36**.

---

## 3. What changed in v2

| | v1 | v2 |
|---|---|---|
| training corpus | 2,043,664 rows | **4,006,719** rows |
| fraud train rows | 328,767 | 1,296,675 (`fraud_payment`) |
| financial rows with user history | **0%** | **80.6%** |
| feature declarations | 3 hand-synced copies | 1 (`ml/feature_spec.py` + `CONTRACT_HASH`) |
| fraud models | 1 | 2 (payment / application) |
| `severity` at source | `3 if fraud else 0` | ex-ante triage, `0` for financial |
| leak detection | none | corpus alias guard + per-source single-feature AUC audit |

**Sparkov added** (plus the FinSpark conformance export, §7.3).  (`kartik2112/fraud-detection`, **CC0-1.0**): 1,852,394 txns,
999 cards, 693 merchants, 2019-01-01 → 2020-12-31, 0.521% fraud, **median 1,471
txns per card**. It is the only public source in the corpus with usable
per-customer sequences, and it is kept **whole** — sampling it would reinstate
the exact bug it was acquired to fix.

**Two sources dropped, with cause** (`ml/feature_spec.py::EXCLUDED_SOURCES`):

- **paysim** — promoting its balance columns exposed the simulator's own
  generating rule: `balance_before == amount AND balance_after == 0` fires on
  8,024 rows with **zero false positives** and 97.7% recall. A head trained with
  it scored a fake **ROC-AUC 1.0000** on paysim. Won't transfer to a real bank.
- **creditcard** — its whole signal is `V1..V28`, PCA components no bank can
  reconstruct or send. Only `amount` + timestamp are servable.

---

## 4. The features actually changed behaviour

v1 `fraud` top-5 by mean |SHAP| — no history feature has any weight, and
`event_type` (#2) is just the model recovering which dataset a row came from:

```
amount            1.103
event_type        0.477     <- dataset identity, not fraud signal
f_log1p_amount    0.365
duration_s        0.299
f_hour            0.291
```

v2 `fraud_payment`:

```
amount                          2.081
merchant_category               0.765
f_hour_cos                      0.719
f_log1p_amount                  0.645
f_user_distinct_counterparties  0.481     <- history, was structurally absent
f_amount_ratio_mean             0.330     <- was exactly 0.0 in v1
```

Separation of the new banking features on Sparkov (benign → fraud):

| feature | benign | fraud | |
|---|---:|---:|---|
| `f_user_txn_count_1h` | 0.198 | **0.677** | 3.4× velocity spike |
| `f_amount_z_user` | 0.002 | **4.06** | 4σ above the customer's own mean |
| `f_amount_ratio_mean` | 0.98 | **7.12** | 7× normal spend |
| `f_counterparty_new` | 0.285 | 0.458 | new payee |
| `f_merchant_category_novel` | 0.007 | 0.057 | 8× more likely novel |

These are exactly the plain-language reasons §4.2 asks for ("amount 300× the
user's normal", "beneficiary activated 5 min ago") — now learnable rather than
aspirational.

---

## 5. Where v2 is deliberately worse

### `behaviour` 0.8167 → 0.7033

`country` was v1's #1 feature at mean |SHAP| **0.755 — 8× the next**. But RBA's
label rate is **0.78 for US vs 0.10 for NO**: that is corpus construction, not
account-takeover signal, and a single-country bank sees one constant value.
Removing it (plus the severity-derived `f_device_past_hisev_count`) costs 0.113
ROC-AUC and buys a model that can transfer. RBA also has a **median of 1 login
per user**, so user history cannot rescue it — a genuinely better behaviour model
needs different data, not different hyperparameters.

### `fraud_application` 0.7927 is not a regression

There was no v1 equivalent. v1's single 0.838 was measured on a *mixture* where
`event_type` separated account-opening from payments — part of that number was
dataset identity. Split honestly: payments 0.9981, applications 0.7927.

---

## 6. Known-bad, retained on purpose

The new per-source audit (`ml/evaluate.py::single_feature_auc_audit`, recorded as
`single_feature_leak_audit` in each `metrics_<key>.json`) reports:

| model | feature | source | AUC |
|---|---|---|---:|
| `cyber` | `f_device_past_hisev_count` | beth | **0.9995** |

(`f_user_past_malicious_rate` was flagged at 0.9977 here until the label-lag
replay landed — see §7.1. Replaying labels at their true arrival time removed
that leak outright.)
| `fraud_payment` | — | — | clean |
| `fraud_application` | — | — | clean |
| `behaviour` | — | — | clean |

Both are label-derived and both sit in the **frozen** `cyber` model. Cyber's
0.9975 should be read as dataset-identity recovery, not threat detection: beth
has 149,940 positives in train and **0 in val/test**, and cicids2017 is 100%
positive in every split. Not fixed because cyber is off the bank's money path —
but no claim should be made about that number until it is.

---

## 6b. Risk bands (resolved)

Bands are now **fitted**, not constants. `risk_score` remains a calibrated
probability; each band edge is the cost-optimal threshold at a stated c_fn/c_fp
ratio (medium 60, high 20, critical 5), fitted on fused validation risk.

| model | low/medium | medium/high | high/critical |
|---|---:|---:|---:|
| `fraud_payment` | 0.0138 | 0.0396 | 0.2430 |
| `fraud_application` | 0.0922 | 0.2760 | 0.6471 |
| `cyber` | 0.0069 | 0.1559 | 0.1837 |
| `behaviour` | 0.0574 | 0.1148 | 0.4074 |
| `quantum` | *(default; bimodal scores)* | | |

A moderately unusual payment that previously reported `low` at 0.0396 now
correctly reports `high`.

## 7. Serving behaviour, not just offline metrics

Two defects were invisible to every offline metric and only appeared when
scoring through the running FastAPI service.

### 7.1 A feature the bank cannot populate was suppressing every score

`f_user_past_malicious_rate` is built offline from labels known instantly, but
online it comes from `POST /feedback` — empty until the bank has been posting
adjudications for months.

| | training (sparkov) | serving |
|---|---:|---:|
| share with rate > 0 | **54.0%** | **0%** |
| mean on fraud rows | 0.107 | — |
| mean on benign rows | 0.0054 | — |

The model learned "rate == 0 means benign". End-to-end, it was the largest single
driver at SHAP **−3.86**, cancelling `amount` (+3.40) and scoring an obviously
fraudulent payment — 300× the customer's normal, brand-new payee, 03:00, novel
category — at **0.0001**.

Removed from `fraud_payment` and `behaviour` (`USER_F_SERVABLE`). Same payment
now scores **0.0444**, with `amount` correctly on top. Cost: F1 0.8411 → 0.8064,
ROC-AUC unchanged at 0.9976.

**Follow-up (resolved).** `engineer_batch` now replays labels at their true
confirmation time, and the feature was re-tested against that. It still does not
earn a place: with realistic label arrival its separation collapses to
0.0000 (fraud) vs 0.0031 (benign) on sparkov, from 0.107 vs 0.0054 under instant
labels. The 20x separation was leakage, not signal. It stays out. The lag
machinery is retained because it removed a real leak from the frozen `cyber`
model — the per-source audit now flags one feature where it flagged two.

### 7.2 The risk bands do not fit a calibrated model

| event | risk | band |
|---|---:|---|
| normal purchase (60-txn history, familiar merchant) | 0.0000 | low |
| fraud-shaped payment | 0.0444 | **low** |

0.0444 against a 0.33% base rate is a **13× lift** — but the bank's fixed bands
(`<.25` low) report it as low. Isotonic calibration is behaving correctly; a
calibrated probability at a realistic base rate simply does not reach 0.25.

This is requirements-doc §4.3, quantified. It needs a decision:
percentile/lift-based bands, per-head cut points, or recalibration on FinSpark
traffic. `ml/evaluate.py::pick_threshold_cost` already yields the business
operating point (`fraud_payment`: recall 0.885 at precision 0.589 with
c_fn = 20·c_fp); it is not yet wired into the bands.

---

## 8. Latency (unchanged, well inside SLA)

| model | v1 p50 | v2 p50 | SLA |
|---|---:|---:|---:|
| fraud / `fraud_payment` | 1.374 ms | 2.510 ms | 10 ms |
| `fraud_application` | — | 1.464 ms | 10 ms |
| cyber | 0.771 ms | 0.791 ms | 10 ms |
| behaviour | 0.586 ms | 0.719 ms | 10 ms |
| quantum | 1.379 ms | 1.427 ms | 10 ms |

`fraud_payment` costs ~1.1 ms more for a much wider feature set — irrelevant
against the bank's ~800 ms client budget.

---

## 9. Reproduce

```bash
python -m ml.run_pipeline          # retrain all five models (~50 s CPU)
python -m ml.benchmark --check     # regression gate vs committed baseline
pytest -m ""                       # full suite (152 tests)
```

Artifacts: `reports/ml/metrics_all.json`, `reports/ml/MODELS.md`,
`benchmarks/baselines/metrics_baseline.json`, `reports/ml/split_manifest.json`.

---

## 10. FinSpark path (schema v2, Phase 5)

`notebooks/src/15_finspark.py` loads the bank's export and asserts the spec's
acceptance rules on receipt: unique `eventId`, payment fraud rate within
0.05–2%, median >= 50 events per customer, `confirmedAt` never earlier than its
own event, and no column that aliases the label.

Until the real export exists, `notebooks/finspark_gen.py` writes spec-conformant
data tagged `source_dataset="finspark_synth"`. **It is currently in the training
corpus as scaffolding** — remove it from `feature_spec.MODEL_SOURCES` when the
bank's export arrives. Per-source metrics are reported separately so it cannot
flatter the Sparkov numbers.

The generator's first version was rejected by the label-alias guard: it gave
every fraud a freshly-added payee and every benign payment an old one, making
`counterparty.isNew` a 0.985-balanced-accuracy alias of the target. Real
customers pay newly-added payees legitimately, and the generator now models that
overlap — the same guard that would have caught v1's `severity`.

FinSpark is in `NO_SAMPLE`: the spec asks for >= 2M events, which would exceed
the per-stratum cap and be row-sampled, shattering the whole-customer sequences
the spec exists to guarantee.
