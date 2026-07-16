# Sentinel Fusion AI — Baseline Model Report (Phase 2)

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
