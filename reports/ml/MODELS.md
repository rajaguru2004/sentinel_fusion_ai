# Sentinel Fusion AI — Model Report

> ## Phase 5 update (2026-07-23) — bands, label lag, FinSpark
>
> | model | ROC-AUC | PR-AUC | F1 | fitted bands (low/med/high edges) |
> |---|---:|---:|---:|---|
> | `fraud_payment` | **0.9981** | 0.8897 | **0.8314** | 0.0138 / 0.0396 / 0.2430 |
> | `fraud_application` | 0.7927 | 0.3469 | 0.3814 | 0.0922 / 0.2760 / 0.6471 |
> | `cyber` | 0.9975 | 0.9960 | 0.9620 | 0.0069 / 0.1559 / 0.1837 |
> | `behaviour` | 0.7033 | 0.7144 | 0.7476 | 0.0574 / 0.1148 / 0.4074 |
> | `quantum` | 1.0000 | 0.9999 | 0.9958 | *(default — scores are bimodal)* |
> | fusion | **0.9811** | | | |
>
> ### 1. Risk bands are now fitted, not constants
>
> `risk_score` stays a genuine calibrated probability — rescaling it would have
> fixed the bands but destroyed calibration monitoring and audit. The **bands**
> moved instead. Each edge is the cost-optimal threshold at a stated c_fn/c_fp
> ratio (`config.BAND_COST_RATIOS` = medium 60, high 20, critical 5), fitted on
> fused validation risk, so every boundary maps to a business trade-off rather
> than a round number.
>
> End-to-end effect on a 40-transaction customer:
>
> | event | risk | band before | band now |
> |---|---:|---|---|
> | normal purchase | 0.0000 | low | low |
> | moderately unusual | 0.0396 | low | **high** |
> | fraud-shaped payment | 1.0000 | critical | critical |
>
> Where a model's score distribution is sharply bimodal every cost ratio returns
> the same optimum; the bands are then spread around that single threshold
> rather than discarded (falling back to 0.25 would have put *all* of
> `behaviour`'s positives in "low", since its whole range sits below 0.25).
> `quantum` still falls back, correctly — it is a rule-recovery model whose
> scores are 0 or 0.9.
>
> ### 2. Label lag: `f_user_past_malicious_rate` stays OUT
>
> `engineer_batch` now replays labels at the time they would actually have been
> known — `label.confirmedAt` where the source supplies it, else a deterministic
> hash-selected 60% confirmed after 7 days. The feature was then re-measured
> against the gate "re-add only if it survives".
>
> **It does not survive.** With realistic label arrival its discriminative power
> vanishes:
>
> | source | mean \| fraud | mean \| benign | with instant labels |
> |---|---:|---:|---|
> | sparkov | **0.0000** | 0.0031 | 0.107 vs 0.0054 (20x) |
> | finspark_synth | 0.0015 | 0.0018 | — |
> | beth | 0.0000 | 0.0000 | single-feature AUC 0.9977 |
>
> Fraud clusters in time, so by the time a customer's first case is adjudicated
> the rest have already happened. The feature's apparent value was entirely
> instant-label leakage. It remains excluded from `fraud_payment` and
> `behaviour`.
>
> The lag machinery still earns its place: it removed a genuine leak from the
> frozen `cyber` model. The per-source leak audit now flags **one** feature
> (`f_device_past_hisev_count`, beth AUC 0.9995) where it previously flagged two.
>
> ### 3. FinSpark path is live end-to-end
>
> `notebooks/src/15_finspark.py` loads the bank export, asserts the spec's
> acceptance rules on receipt (unique ids, 0.05–2% fraud rate, median ≥50 events
> per customer, `confirmedAt` never preceding its event, no label alias) and maps
> straight onto the canonical schema.
>
> Until the real export exists, `notebooks/finspark_gen.py` emits spec-conformant
> data tagged `source_dataset="finspark_synth"` so the whole path stays
> exercised. **This is scaffolding and is currently in the training corpus** —
> remove it from `feature_spec.MODEL_SOURCES` the day the real export lands.
> Per-source metrics are reported separately so it cannot flatter the sparkov
> numbers.
>
> Writing the generator immediately paid for itself: the label-alias guard
> rejected the first version, because it gave every fraud a fresh payee and every
> benign payment an old one, making `isNew` a 0.985-balanced-accuracy alias of
> the target. Real customers pay newly-added payees legitimately, and the
> generator now models that overlap.
>
> FinSpark is in `NO_SAMPLE`: the spec asks for ≥2M events, which would exceed
> the per-stratum cap and get row-sampled — shattering exactly the whole-customer
> sequences the spec demands, on the one source shaped like production.

> ## Phase 4 / schema v2 update (2026-07-23)
>
> **Corpus rebuilt, fraud model split in two, two datasets dropped for cause.**
>
> | model | ROC-AUC | PR-AUC | F1 | Precision | Recall |
> |---|---:|---:|---:|---:|---:|
> | `fraud_payment` (was `fraud`) | **0.9976** (0.838) | **0.8700** (0.536) | **0.8064** (0.498) | **0.8223** (0.510) | 0.7911 (0.486) |
> | `fraud_application` (new) | 0.7927 | 0.3469 | 0.3814 | 0.3575 | 0.4086 |
> | `cyber` (frozen) | 0.9975 | 0.9961 | 0.9620 | 0.9552 | 0.9690 |
> | `behaviour` (rebuilt) | **0.7033** (was 0.8167) | 0.7144 | 0.7476 | 0.6310 | 0.9168 |
> | `quantum` (frozen) | 1.0000 | 0.9999 | 0.9958 | 0.9916 | 1.0000 |
> | fusion | **0.9693** (0.9717) | | | | |
>
> v1 values in parentheses. `cyber` and `quantum` reproduce v1 **exactly**,
> confirming the freeze held across a corpus rebuild.
>
> ### What actually changed
>
> 1. **Dataset-native features now reach training.** `11_unify.py` built the
>    compact corpus as `[c for c in UNIFIED_COLUMNS if c != "attributes"]`, and
>    every source's real features were packed inside `attributes`. The v1 fraud
>    model trained on 15 numerics + `event_type`; 0.838 was a data-plumbing
>    ceiling, not a modelling one.
> 2. **User history exists now.** v1: **0%** of fraud training rows had any user
>    history — `f_user_seq_no`, `f_user_secs_since_last`, `f_amount_z_user`,
>    `f_amount_ratio_mean` all scored mean |SHAP| exactly **0.0**. Row-level
>    sampling had shattered sequences, and PaySim has 1.0 events/user even at
>    full size. Adding Sparkov (999 cards, median 1,471 txns each, CC0) and
>    keeping it un-sampled took financial coverage to **79.7%**. Three of those
>    four features are now in the top 8 by SHAP.
> 3. **Two heads.** `event_type` was the v1 fraud model's #2 feature (SHAP 0.477)
>    — capacity spent separating payments from account applications. Each head
>    now gets a contract that is actually populated.
> 4. **`severity` is no longer label-derived** at source (agreement with `label`
>    was exactly 1.0000 for baf/beth/creditcard/paysim/rba).
>
> ### Sources dropped, with cause
>
> - **paysim** — promoting its balance columns (correct in general) exposed the
>   simulator's own fraud rule: `balance_before == amount AND balance_after == 0`
>   fires on 8,024 rows with **zero false positives** and 97.7% recall. A head
>   trained with it scored a fake ROC-AUC of **1.0000** on paysim. Real fraudsters
>   do not reliably zero an account, so it would not transfer. The balance
>   *features* are kept — FinSpark supplies them honestly.
> - **creditcard** — its whole signal is `V1..V28`, PCA components no bank can
>   reconstruct or send. Under the servability rule only `amount` + timestamp
>   remain.
>
> ### Known leaks, retained deliberately
>
> The new per-source single-feature AUC audit (`ml/evaluate.py`,
> `single_feature_leak_audit` in each `metrics_<key>.json`) flags:
>
> - `f_device_past_hisev_count` — AUC **0.9995** on beth
> - `f_user_past_malicious_rate` — AUC **0.9977** on beth
>
> Both are built from past labels (`severity`/`pos`), and both live in the
> **frozen cyber** model. Cyber's 0.9975 should therefore be read as
> dataset-identity recovery, not threat detection: beth has 149,940 positives in
> train and **0 in val/test**, and cicids2017 is 100% positive in every split.
> Not fixed here because cyber is off the bank's money path; fix before any claim
> is made about it.
>
> ### Behaviour got worse on purpose
>
> `country` was the #1 feature at SHAP 0.755 — 8x the next — but RBA's label rate
> is 0.78 for US vs 0.10 for NO. That is corpus construction, not account-takeover
> signal, and a single-country bank sees one constant value. Removing it costs
> 0.095 ROC-AUC and buys a model that can transfer. RBA also has a median of
> **1 login per user**, so user-history features cannot help it either.
>
> ### `f_user_past_malicious_rate` removed from the servable models
>
> Caught by an end-to-end check against the running service, not by any offline
> metric. The feature is built offline from labels known instantly, but online it
> comes from `POST /feedback`, which is empty until the bank has been posting
> adjudications for months:
>
> | | training (sparkov) | serving |
> |---|---|---|
> | share with rate > 0 | **54.0%** | **0%** |
> | mean, fraud rows | 0.107 | — |
> | mean, benign rows | 0.0054 | — |
>
> The model learned "rate == 0 means benign". In a live check it was the single
> largest driver at SHAP **-3.86**, cancelling `amount` (+3.40) and scoring an
> obviously fraudulent payment (300x the customer's normal, brand-new payee,
> 03:00, novel category) at **0.0001**. After removing it from `fraud_payment`
> and `behaviour` (`USER_F_SERVABLE`), the same payment scores **0.0444** — a
> 13x lift over the 0.33% base rate, with `amount` correctly on top.
>
> Cost: `fraud_payment` F1 0.8411 -> 0.8064, ROC-AUC unchanged at 0.9976. Cheap
> insurance against a feature the bank cannot populate on day one. The frozen
> cyber model keeps it (and its 0.9977 beth leak), documented above.
>
> Restore it once FinSpark supplies `label.confirmedAt` and `engineer_batch`
> replays labels at their true confirmation time (`LABEL_LAG_S`,
> `LABEL_CONFIRM_RATE` are declared in `ml/feature_spec.py`, not yet applied).
>
> ### Open: risk bands vs a calibrated model
>
> The bank's decision bands (`<.25` low, `<.50` medium, `<.75` high) assume
> scores that reach those levels. A correctly calibrated model at a 0.33% base
> rate rarely does: the fraud-shaped payment above is a 13x lift yet lands at
> 0.044, i.e. **"low"**. Isotonic calibration is doing its job — 0.044 really is
> a ~4% chance of fraud — but a fixed 0.25 cut will report almost all traffic as
> low.
>
> This is requirements-doc §4.3, now quantified. Options, for the bank to choose:
> percentile/lift-based bands, per-head band thresholds, or recalibrating the
> cut points on FinSpark traffic. `ml/evaluate.py::pick_threshold_cost` already
> produces the business-cost operating point (`fraud_payment`: recall 0.885 at
> precision 0.589 with c_fn = 20 c_fp); it is not yet wired into the bands.


> **Phase 3 update (2026-07-16).** Behaviour model **promoted**: supervised
> LightGBM on labeled rba slice replaces IsolationForest — test ROC-AUC
> **0.584 → 0.817**, F1 0.737 → 0.829, 20× faster single-row; fusion
> cross-domain AUC **0.958 → 0.972** (gate: `ml.benchmark --challenger`,
> +0.286 val / +0.232 test). Fraud 24-config search: challenger lost on test
> PR-AUC (0.526 < 0.536) — baseline stands; population-cost threshold 0.764
> (c_fn=20·c_fp) documented in `experiments/fraud_search.json`. Calibration:
> isotonic beats sigmoid on Brier for all four; fusion weight refit +0.0009
> AUC — not adopted. Test suite: 99 tests; regression gate:
> `python -m ml.benchmark --check`. Rollback: `BEHAVIOUR_MODEL = "iforest"`
> in `ml/config.py`. Terminal SOC demo: `python sentinel_demo.py`.

## Phase 2 baseline report (historical)

Pipeline: `python -m ml.run_pipeline` (~30 s end-to-end, CPU-only, seed 42, no hyperparameter search — deliberate baselines).

## Data & split

- Corpus: `data/unified/unified_events_engineered.parquet` — 2,043,664 events, 5 domains.
- Split: **per-source temporal** 70/15/15 (train/val/test). Within each `source_dataset`, rows ordered by `(event_time, event_id)` and cut at quantiles — deterministic, no RNG, preserves time order, prevents a whole source landing in one split (sources use different synthetic epochs). Composition: `split_manifest.json`.
- Quantum rows get native attributes (`key_exchange`, `cert_key_type`, `data_class`, cert ages) joined back from `part_quantum_synth.parquet` — the core schema is too thin for that domain.

## Leakage guards

- `severity` excluded everywhere — label-derived in several sources (e.g. creditcard `severity=3 ⇔ Class=1`).
- `event_subtype` nulled for `unsw_nb15`/`cicids2017` — it carries the attack-category name (the target). BETH keeps syscall subtypes (before the fix cyber scored a fake 1.000).
- Historical features are past-only by construction (phase-1 engineering); thresholds chosen on validation, never test.
- `sampling_weight` never used as a feature or in training; only for population-weighted evaluation.

## Test-set results (threshold = max-F1 on validation)

| Model | Library | Test rows | ROC-AUC | F1 | Precision | Recall | Accuracy | 1-row p50 | Batch rows/s |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Fraud | XGBoost | 68,451 | 0.838 | 0.498 | 0.510 | 0.486 | 0.914 | 1.4 ms | 1.9 M |
| Cyber threat | LightGBM | 89,231 | 0.998 | 0.962 | 0.955 | 0.969 | 0.971 | 0.8 ms | 1.8 M |
| Behaviour | IsolationForest | 45,098 | 0.584 | 0.737 | 0.588 | 0.987 | 0.609 | 14 ms | 124 K |
| Quantum risk | XGBoost | 23,321 | 1.000 | 0.996 | 0.992 | 1.000 | 1.000 | 1.4 ms | 3.0 M |

Full details incl. confusion matrices and population-weighted variants (sampling weights undo the unify-stage benign caps): `metrics_<model>.json`. Weighted fraud precision drops to 0.046 — at population base rates a 0.76 threshold still fires ~62 K FP per ~1 M benign; expected for an untuned baseline, threshold is a business-cost knob.

Reading guide:
- **Cyber 0.998** — honest (post leak fix); flow features on these IDS corpora separate well.
- **Behaviour 0.584 AUC** — unsupervised IsolationForest scored against rba account-takeover labels; near-random ranking is a known-weak baseline. cert_insider rows are unlabeled (`-1`): scored, never evaluated. Phase-3 candidate: supervised or sequence model.
- **Quantum ≈1.0 by design** — the HNDL label is a documented deterministic rule of the joined attributes; this model is rule-recovery / schema-sanity, not a claim.

## Explainability

SHAP TreeExplainer, 2,000-row test sample per model: `shap_<model>_summary.png` (beeswarm), `shap_<model>_bar.png`, `shap_<model>_top_features.json`. Top signals — fraud: `amount`, `event_type`, `f_log1p_amount`; cyber: `dst_port`, `f_user_past_malicious_rate`, `bytes_out`; behaviour: `f_user_seq_no`, `f_device_seq_no`; quantum: `q_data_class`, `q_cert_key_type`, `bytes_out`.

## Risk Fusion Engine (`models/fusion_engine.joblib`)

1. **Calibrate** — per-model isotonic regression (fit on validation) maps heterogeneous outputs (GBM probability, IForest anomaly score) onto one P(malicious) scale.
2. **Combine** — weighted noisy-OR `risk = 1 − Π(1 − wᵢpᵢ)`; weights fraud 1.0, cyber 1.0, quantum 0.9, behaviour 0.7. Missing signals skipped, so single-domain events score correctly; any confident signal dominates, weak independent signals accumulate.
3. **Band** — <0.25 low, <0.50 medium, <0.75 high, ≥0.75 critical.

Cross-domain ROC-AUC of the fused score on labeled test events: **0.958** (`fusion_report.json`, `fusion_risk_hist.png`).

## Artifacts

- `models/<key>_bundle.joblib` — model + feature list + categorical encoder + imputation medians + threshold (self-contained for inference).
- `models/fraud_xgb.json`, `quantum_xgb.json`, `cyber_lgbm.txt` — native boosters (portable, no pickle).
- Online scoring API: `ml/predict.py::SentinelScorer` (`python -m ml.predict` for a demo).
- Reproducibility: `run_manifest.json` — seed, library versions, params, feature lists, stage timings.

## Repro

```bash
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m ml.run_pipeline   # retrain everything
.venv/bin/python -m ml.predict       # score sample events + fused risk
```
