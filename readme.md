# Sentinel Fusion AI

AI-driven cybersecurity & transaction correlation engine. Four CPU-only models — **Fraud Detection (XGBoost)**, **Cyber Threat Detection (LightGBM)**, **Behaviour Analytics (LightGBM, supervised champion)**, **Quantum/HNDL Risk (XGBoost)** — fused by a calibrated **Risk Fusion Engine** (per-model isotonic calibration → weighted noisy-OR) into one unified risk score with SHAP explainability and threat-intel correlation.

Trained on a unified corpus of **2,043,664 events** from 14 public datasets across 5 domains (cyber, financial, behaviour, threat-intel, quantum), one common event schema.

---

## 🎬 Demo — run this

Terminal SOC demonstration: a 5-event account-takeover → exfiltration → wire-fraud attack unfolding in real time, analyzed live by the real trained models.

```bash
# one-time setup (see Setup below), then:
.venv/bin/python sentinel_demo.py              # full attack story, dramatic pacing
.venv/bin/python sentinel_demo.py --all        # attack + benign contrast, back to back
.venv/bin/python sentinel_demo.py --scenario benign
.venv/bin/python sentinel_demo.py --fast       # no pauses (rehearsal/CI)
.venv/bin/python sentinel_demo.py --no-color   # plain terminal
```

What the demo shows, stage by stage:

| Stage | What happens | Real? |
|---|---|---|
| Component loading | 4 model bundles + fusion engine + SHAP explainers + threat-intel DB, per-component load times | ✓ measured |
| Incoming events | 09:01 login from new country → 09:03 PowerShell security-file access (T1059) → 09:05 bulk transfer to C2 → 09:07 high-value transfer (4.6M) → 09:08 bulk TLS upload on quantum-breakable channel | real labeled test-split rows, story identities |
| Feature engineering | engineered feature values the models consume | ✓ actual model inputs |
| Model routing & inference | each event routed to its domain model, probability + confidence + per-event inference ms | ✓ live predictions |
| Risk Fusion | per-domain max → isotonic calibration → weighted noisy-OR → unified score + band | ✓ real fusion engine |
| Explainable AI | top contributing signals, direction + weight | ✓ SHAP TreeExplainer, computed live (~26 ms) |
| Threat intelligence | destination IP matched against **real Feodo Tracker feed** (hits QakBot C2), technique resolved via **MITRE ATT&CK** | ✓ real feed lookups |
| Correlation timeline | attack chain linked by user/device/time | ✓ |
| SOC report | CRITICAL verdict, per-model verdicts, recommended P1 actions | ✓ |
| Performance | ~90 ms total analysis, ~0.5 GB RSS, model version | ✓ measured |

Attack scenario ⇒ **CRITICAL, risk 1.0000, all 5 events flagged**. Benign scenario ⇒ **LOW, risk 0.0008, no TI match**. Predictions are never faked — event data is simulated (built from real labeled test rows by `demo/build_scenarios.py`), every number comes out of the serialized models at runtime.

Regenerate scenarios (needs full data locally): `.venv/bin/python -m demo.build_scenarios`

---

## Benchmark results

Test split (per-source temporal 70/15/15, no leakage), threshold = max-F1 on validation. Reproduce: `python -m ml.benchmark`. Baseline gate: `benchmarks/baselines/metrics_baseline.json`.

| Model | Library | ROC-AUC | PR-AUC | F1 | Precision | Recall | 1-row p50 | Batch rows/s |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Fraud Detection | XGBoost | 0.838 | 0.536 | 0.498 | 0.510 | 0.486 | 1.4 ms | 1.9 M |
| Cyber Threat | LightGBM | 0.998 | 0.996 | 0.962 | 0.955 | 0.969 | 0.8 ms | 1.7 M |
| Behaviour Analytics | LightGBM | **0.817** | 0.792 | 0.829 | 0.733 | 0.953 | 0.7 ms | 8.7 M |
| Quantum Risk | XGBoost | 1.000 | 1.000 | 0.996 | 0.992 | 1.000 | 1.4 ms | 3.0 M |
| **Risk Fusion (cross-domain)** | — | **0.972** | — | — | — | — | — | 955 K fused |

Notes:
- **Behaviour improved 0.584 → 0.817 ROC-AUC** by champion/challenger: supervised LightGBM beat tuned IsolationForest, LOF and ECOD-lite (`reports/ml/experiments/behaviour_champion.json`); promoted through the `ml.benchmark --challenger` gate (+0.286 val, +0.232 test, 20× faster). Fusion AUC rose 0.958 → 0.972. Rollback: `BEHAVIOUR_MODEL = "iforest"` in `ml/config.py`.
- Fraud 24-config randomized search **did not beat** the baseline on test PR-AUC (0.526 < 0.536) — baseline kept; population-cost threshold (c_fn = 20×c_fp) = 0.764 documented in `reports/ml/experiments/fraud_search.json`.
- Quantum ≈ 1.0 **by design** — its label is a documented deterministic HNDL rule; the model is rule-recovery/schema sanity, and a drop signals data breakage.
- Calibration: isotonic beats Platt sigmoid on Brier for all four models; fusion weight refit gained +0.0009 AUC — not adopted (`reports/ml/experiments/calibration_check.json`).
- Leakage guards: `severity` (label-derived in some sources) and unsw/cicids `event_subtype` (= attack name) excluded at load; enforced by tests.

## What was built, end to end

1. **Phase 1 — data**: 14 datasets → cleaned parquet → unified event schema (`docs/unified_schema.md`) → leakage-safe past-only feature engineering → validated 2.04M-row corpus.
2. **Phase 2 — models**: modular `ml/` pipeline (config/data/features/train/evaluate/explain/fusion), per-source temporal split, 4 baselines + SHAP reports + serialized bundles (joblib **and** pickle-free native boosters with score-parity tests), Risk Fusion Engine, ~30 s full retrain.
3. **Phase 3 — verification & improvement**: 99-test pytest suite (unit / integration / quality gates / perf SLAs) on a committed 1.4 MB fixture, benchmark harness with regression gate + history, bounded experiments (fraud search, behaviour champion, calibration check) with gated promotion.
4. **Demo**: `sentinel_demo.py` terminal SOC presentation (this page, above).

## Setup

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt      # or: pip install -e .[train,dev]
```

The demo needs `models/` (committed pipeline outputs regenerate in ~30 s, below) and `demo/scenarios.parquet` (committed). Full retraining needs `data/unified/*.parquet` from Phase 1.

## Training & verification commands

```bash
.venv/bin/python -m ml.run_pipeline            # retrain all 4 models + fusion (~30 s)
.venv/bin/pytest                               # fast tier: 59 tests, <5 s, no big data
.venv/bin/pytest -m ""                         # everything incl. slow/quality/perf gates (99 tests)
.venv/bin/python -m ml.benchmark               # measure + append history
.venv/bin/python -m ml.benchmark --check       # regression gate (exit 1 on breach)
.venv/bin/python -m ml.benchmark --challenger models/challengers/X.joblib --model KEY
make test | test-all | gates | bench | experiments | lint   # shortcuts
```

## Repo layout

```
ml/               training pipeline + benchmark + experiments
demo/             SOC demo engine, renderer, scenario builder + scenarios.parquet
sentinel_demo.py  demo entry point
tests/            pytest suite (unit/integration/quality/perf) + committed mini fixture
benchmarks/       committed baseline floors + run history (JSONL)
models/           trained bundles + native boosters (gitignored, regenerate in ~30 s)
reports/ml/       metrics, SHAP plots, fusion report, experiments, MODELS.md
data/, notebooks/, docs/, reports/   Phase 1 (below)
```

## Phase 1 — Dataset Collection & Preprocessing

```
data/raw/         raw downloads (gitignored): cyber, financial, behaviour, threat_intel
data/clean/       cleaned per-dataset parquet
data/unified/     part_*.parquet + unified_events.parquet + unified_events_engineered.parquet
notebooks/        01-13 preprocessing/unify/features/validation notebooks
notebooks/src/    percent-format sources (python notebooks/_make_nb.py regenerates .ipynb)
docs/             unified_schema.md, data_dictionary.md
reports/          per-dataset stats, EDA figures, validation_report.{json,md}
```

Run order: 01→10 (any order, independent), then 11_unify → 12_feature_engineering → 13_validation_report.

Re-download raw data: `bash` the Kaggle slugs in `docs/data_dictionary.md` (creds via `.env`:
`KAGGLE_USERNAME=...` / `KAGGLE_TOKEN=...`).
