"""Central configuration — single source of truth for the ML pipeline.

Everything that affects reproducibility lives here: seed, split fractions,
feature lists, model hyperparameters (sensible CPU baselines, no tuning).
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UNIFIED = ROOT / "data" / "unified"
MODELS = ROOT / "models"
ML_REPORTS = ROOT / "reports" / "ml"
REGISTRY = MODELS / "registry"
BENCH_DIR = ROOT / "benchmarks"
for _d in (MODELS, ML_REPORTS):
    _d.mkdir(parents=True, exist_ok=True)

ENGINEERED_PARQUET = UNIFIED / "unified_events_engineered.parquet"
QUANTUM_PART_PARQUET = UNIFIED / "part_quantum_synth.parquet"  # native attrs join

SEED = 42
N_JOBS = max(1, (os.cpu_count() or 4) - 1)
TRAIN_FRAC, VAL_FRAC = 0.70, 0.15  # test = remainder; per-source temporal quantiles

# ---------------------------------------------------------------- features ----
# Feature lists moved to ml/feature_spec.py — THE contract, shared by training and
# serving and fingerprinted by CONTRACT_HASH. Re-exported here so existing
# imports (`from .config import FEATURES`) keep working.
#
# EXCLUDED everywhere: severity (label-derived in v1; see docs/canonical_schema.md),
# label_type, source_dataset, sampling_weight, event_id, attack_technique.
from .feature_spec import (  # noqa: E402
    CONTRACT_HASH,
    DEVICE_F,
    FROZEN_MODELS,
    MODEL_SOURCES,
    TEMPORAL_F,
    USER_F,
    route,
)
from .feature_spec import (
    MODEL_FEATURES as FEATURES,
)

# Domain each model scores. v1 mapped one model per domain; the financial domain
# now has two heads (payment vs application), so routing also consults
# event_type — see feature_spec.route().
DOMAIN_OF_MODEL = {"fraud_payment": "financial", "fraud_application": "financial",
                   "cyber": "cyber", "behaviour": "behaviour", "quantum": "quantum"}

# Explicit re-export surface (also stops ruff F401 flagging the pass-throughs).
__all__ = ["FEATURES", "TEMPORAL_F", "USER_F", "DEVICE_F", "MODEL_SOURCES",
           "FROZEN_MODELS", "CONTRACT_HASH", "route", "DOMAIN_OF_MODEL",
           "SEED", "N_JOBS", "TRAIN_FRAC", "VAL_FRAC", "XGB_PARAMS",
           "LGBM_PARAMS", "IFOREST_PARAMS", "FUSION_WEIGHTS", "RISK_BANDS",
           "BEHAVIOUR_MODEL", "FAST_PARAMS", "SLA", "COST", "MODELS",
           "ML_REPORTS", "ENGINEERED_PARQUET", "QUANTUM_PART_PARQUET"]

# Behaviour model kind. "lgbm_supervised" promoted 2026-07-16 via
# ml.benchmark --challenger: val ROC-AUC 0.8514 vs IsolationForest 0.5843
# (+0.286), test +0.232, 20x faster single-row. Trains on the LABELED
# behaviour slice (rba); unlabeled cert_insider rows are still scored.
# Rollback: set to "iforest".
BEHAVIOUR_MODEL = "lgbm_supervised"

# ------------------------------------------------------------ model params ----
# CPU baselines. hist method, moderate depth/estimators. No tuning by design.
XGB_PARAMS = dict(
    n_estimators=400, learning_rate=0.1, max_depth=6, min_child_weight=5,
    subsample=0.8, colsample_bytree=0.8, tree_method="hist",
    eval_metric="aucpr", early_stopping_rounds=30, n_jobs=N_JOBS,
    random_state=SEED,
)
LGBM_PARAMS = dict(
    n_estimators=500, learning_rate=0.1, num_leaves=63, min_child_samples=50,
    subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
    objective="binary", n_jobs=N_JOBS, random_state=SEED, verbosity=-1,
)
IFOREST_PARAMS = dict(
    n_estimators=300, max_samples=256, contamination="auto",
    n_jobs=N_JOBS, random_state=SEED,
)

# ---------------------------------------------------------------- fusion ------
# Domain weights: relative trust/severity prior per signal. Behaviour lowest —
# unsupervised score, weakest calibration guarantees.
# Both fraud heads inherit the v1 fraud weight — the split is about giving each
# a populated feature contract, not about trusting one more than the other.
FUSION_WEIGHTS = {"fraud_payment": 1.0, "fraud_application": 1.0,
                  "cyber": 1.0, "behaviour": 0.7, "quantum": 0.9}
# Fallback bands, used only when a model has no fitted cut points (legacy
# bundles, or a model with too few validation positives to fit on).
RISK_BANDS = [(0.25, "low"), (0.50, "medium"), (0.75, "high"), (1.01, "critical")]

# Per-model band cut points are FITTED instead (ml.fusion.fit_bands).
#
# Why: `risk_score` is a genuine calibrated probability, so at a realistic fraud
# base rate (~0.3%) even a strong signal lands near 0.05 — the fixed 0.25/0.50
# constants then report almost all traffic as "low". Rescaling the score would
# fix the bands but destroy the probability contract (and with it calibration
# monitoring), so the score is left alone and the BANDS move.
#
# Each boundary is the cost-optimal threshold at a stated c_fn/c_fp ratio, which
# is what makes the bands defensible to a risk committee: "high" begins where
# missing a fraud costs 20x a false positive — the ratio already in COST below.
# A larger ratio means false negatives hurt more, so the threshold drops and the
# band opens earlier; hence medium(60) < high(20) < critical(5).
BAND_COST_RATIOS = {"medium": 60.0, "high": 20.0, "critical": 5.0}

LATENCY_SINGLE_ROWS = 200   # single-row predict calls to time
LATENCY_BATCH_SIZE = 10_000
SHAP_SAMPLE = 2000          # test rows per SHAP report

# ------------------------------------------------------------ fast / test ----
# Tiny-model overrides for test fixtures and pipeline smoke runs.
FAST_PARAMS = {
    "xgb": dict(n_estimators=30, early_stopping_rounds=5, max_depth=4),
    "lgbm": dict(n_estimators=40, num_leaves=15),
    "iforest": dict(n_estimators=50, max_samples=128),
}

# Inference SLAs enforced by tests/perf and ml.benchmark --check (reference box).
SLA = {
    "gbm_single_row_ms_p50": 10.0,
    "iforest_single_row_ms_p50": 60.0,
    "batch_rows_per_sec_min": 50_000,
    "scorer_cold_start_s": 5.0,
}

# Business cost ratios for cost-sensitive thresholding (experiments).
COST = {"fraud": {"c_fp": 1.0, "c_fn": 20.0}}
