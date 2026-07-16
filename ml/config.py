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
# Shared engineered features (leakage-safe by construction: past-only aggregates).
# EXCLUDED everywhere:
#   severity                 — label-derived in several sources (e.g. creditcard
#                              severity=3 iff Class==1) → direct target leakage
#   label_type, source_dataset, sampling_weight, event_id, attack_technique
TEMPORAL_F = ["f_hour", "f_dayofweek", "f_is_weekend", "f_is_night",
              "f_hour_sin", "f_hour_cos"]
USER_F = ["f_user_seq_no", "f_user_secs_since_last",
          "f_user_past_malicious_rate", "f_user_new_country"]
DEVICE_F = ["f_device_seq_no", "f_device_past_hisev_count"]

# numeric = passed through as float32 (NaN kept for GBMs, imputed for IForest)
# categorical = ordinal-encoded with persisted mapping (unseen -> -1)
FEATURES: dict[str, dict[str, list[str]]] = {
    "fraud": {
        "numeric": ["amount", "f_log1p_amount", "f_amount_z_user",
                    "f_amount_ratio_mean", "duration_s", *USER_F, *TEMPORAL_F],
        "categorical": ["event_type"],
    },
    # cyber event_subtype: attack-category values (unsw_nb15/cicids2017) are
    # nulled at load time (data.load_engineered) — only BETH syscall names remain.
    "cyber": {
        "numeric": ["duration_s", "bytes_in", "bytes_out", "f_log1p_bytes_in",
                    "f_log1p_bytes_out", "f_bytes_ratio", "src_port", "dst_port",
                    *USER_F, *DEVICE_F, *TEMPORAL_F],
        "categorical": ["event_type", "event_subtype", "protocol"],
    },
    "behaviour": {
        "numeric": ["duration_s", *USER_F, *DEVICE_F, *TEMPORAL_F],
        "categorical": ["event_type", "event_subtype", "country"],
    },
    # Quantum core schema is thin — native attrs joined from part_quantum_synth
    # (q_ prefix). Label is a documented deterministic HNDL rule of these fields;
    # near-perfect metrics expected — rule-recovery sanity model by design.
    "quantum": {
        "numeric": ["bytes_out", "f_log1p_bytes_out", "f_device_seq_no",
                    "q_cert_age_days", "q_cert_validity_days", *TEMPORAL_F],
        "categorical": ["event_subtype", "country", "q_key_exchange",
                        "q_cert_key_type", "q_data_class"],
    },
}

DOMAIN_OF_MODEL = {"fraud": "financial", "cyber": "cyber",
                   "behaviour": "behaviour", "quantum": "quantum"}

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
FUSION_WEIGHTS = {"fraud": 1.0, "cyber": 1.0, "behaviour": 0.7, "quantum": 0.9}
RISK_BANDS = [(0.25, "low"), (0.50, "medium"), (0.75, "high"), (1.01, "critical")]

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
