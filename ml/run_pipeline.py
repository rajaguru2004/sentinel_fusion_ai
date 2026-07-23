"""End-to-end training pipeline.

    .venv/bin/python -m ml.run_pipeline [--fast] [--skip-shap]

Stages: load -> split -> per model (features -> train -> threshold on val ->
metrics on test -> latency -> SHAP -> serialize) -> fusion engine (calibrate
on val, fuse test set) -> reference stats (drift baseline) -> manifest.

`run()` is parameterizable so tests/experiments reuse it: pass a pre-loaded
df (fixture), alternate output dirs, fast=True for tiny models.

Artifacts (into models_dir / reports_dir):
    <key>_bundle.joblib          model + encoder + medians + threshold + features
    fraud_payment_xgb.json, fraud_application_xgb.json,
    cyber_lgbm.txt, quantum_xgb.json                   native boosters
    fusion_engine.joblib, reference_stats.json
    metrics_<key>.json, shap_<key>_*.{png,json}, fusion_report.json,
    fusion_risk_hist.png, split_manifest.json, run_manifest.json, metrics_all.json
"""
from __future__ import annotations

import json
import platform
import time

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from . import data as D
from . import features as F
from . import train as T
from .config import (
    BEHAVIOUR_MODEL,
    CONTRACT_HASH,
    FAST_PARAMS,
    FEATURES,
    FUSION_WEIGHTS,
    IFOREST_PARAMS,
    LGBM_PARAMS,
    ML_REPORTS,
    MODELS,
    SEED,
    XGB_PARAMS,
)
from .evaluate import (
    compute_metrics,
    latency_benchmark,
    pick_threshold,
    single_feature_auc_audit,
)
from .fusion import RiskFusionEngine

MODEL_LIB = {"fraud_payment": "xgboost", "fraud_application": "xgboost",
             "cyber": "lightgbm",
             "behaviour": ("lightgbm" if BEHAVIOUR_MODEL == "lgbm_supervised"
                           else "isolation_forest"),
             "quantum": "xgboost"}


def train_one(key: str, df: pd.DataFrame, split: pd.Series, *,
              models_dir=MODELS, reports_dir=ML_REPORTS,
              fast: bool = False, skip_shap: bool = False,
              params: dict | None = None) -> dict:
    """Train + evaluate + serialize ONE model. Returns
    {bundle, metrics, s_va, y_va, test_index, test_scores, X_tr}."""
    # behaviour: LGBM champion trains supervised on the labeled slice (rba);
    # IsolationForest (rollback kind) fits unsupervised on ALL behaviour rows.
    supervised = key != "behaviour" or BEHAVIOUR_MODEL == "lgbm_supervised"
    tr = D.domain_slice(df, split, key, "train", labeled_only=supervised)
    va = D.domain_slice(df, split, key, "val", labeled_only=True)
    te = D.domain_slice(df, split, key, "test", labeled_only=True)

    X_tr, enc = F.build_matrix(tr, key)
    X_va, _ = F.build_matrix(va, key, enc)
    X_te, _ = F.build_matrix(te, key, enc)
    y_tr, _ = F.labels_and_weights(tr)
    y_va, _ = F.labels_and_weights(va)
    y_te, w_te = F.labels_and_weights(te)

    lib = MODEL_LIB[key]
    fast_over = (FAST_PARAMS["xgb"] if lib == "xgboost" else
                 FAST_PARAMS["lgbm"] if lib == "lightgbm" else FAST_PARAMS["iforest"])
    over = {**(fast_over if fast else {}), **(params or {})}

    medians = None
    if key == "behaviour" and lib == "isolation_forest":
        medians = F.fit_imputer(X_tr)
        X_tr, X_va, X_te = (F.impute(x, medians) for x in (X_tr, X_va, X_te))
        model = T.train_iforest(X_tr, over)
    elif lib == "lightgbm":
        model = T.train_lgbm(X_tr, y_tr, X_va, y_va, over)
    else:
        model = T.train_xgb(X_tr, y_tr, X_va, y_va, over)

    # Leak audit BEFORE trusting any metric: a single feature that ranks the
    # label near-perfectly inside one source is an alias, not a signal.
    leaks = single_feature_auc_audit(X_tr, y_tr, tr["source_dataset"]) if supervised else []
    if leaks:
        print(f"  !! single-feature leak audit flagged {len(leaks)}: {leaks[:5]}")

    s_va, s_te = T.score(model, X_va), T.score(model, X_te)
    threshold = pick_threshold(y_va, s_va)
    metrics = {
        "model": key, "library": lib,
        "rows": {"train": int(len(tr)), "val": int(len(va)), "test": int(len(te))},
        "positive_rate_train": round(float((y_tr == 1).mean()), 4),
        "threshold_val_maxF1": round(threshold, 6),
        "test": compute_metrics(y_te, s_te, threshold),
        "test_population_weighted": compute_metrics(y_te, s_te, threshold, w_te),
        "latency": latency_benchmark(model, X_te),
        "single_feature_leak_audit": leaks,
    }
    if supervised:
        best_it = getattr(model, "best_iteration", None) or getattr(model, "best_iteration_", None)
        metrics["best_iteration"] = int(best_it) if best_it else None
    if not skip_shap:
        from .explain import shap_report
        metrics["shap_top_features"] = shap_report(model, X_te, key,
                                                   reports_dir=reports_dir)

    # contract_hash pins the feature contract this model was trained under; the
    # service refuses to start on a mismatch (service/app.py::check_contract).
    bundle = {"model": model, "features": list(X_tr.columns),
              "encoder_mapping": enc.mapping, "medians": medians,
              "threshold": threshold, "library": lib, "seed": SEED,
              "contract_hash": CONTRACT_HASH}
    joblib.dump(bundle, models_dir / f"{key}_bundle.joblib", compress=3)
    if lib == "xgboost":
        booster = model.get_booster()
        best_it = getattr(model, "best_iteration", None)
        if best_it is not None:  # slice off post-early-stop trees so the
            booster = booster[: best_it + 1]  # native file scores identically
        booster.save_model(models_dir / f"{key}_xgb.json")
    elif lib == "lightgbm":
        model.booster_.save_model(str(models_dir / f"{key}_lgbm.txt"))
    (reports_dir / f"metrics_{key}.json").write_text(json.dumps(metrics, indent=2))

    # scores for ALL test rows of the domain (incl. unlabeled) -> fusion demo
    te_all = D.domain_slice(df, split, key, "test", labeled_only=False)
    X_all, _ = F.build_matrix(te_all, key, enc)
    if medians is not None:
        X_all = F.impute(X_all, medians)
    return {"bundle": bundle, "metrics": metrics, "s_va": s_va, "y_va": y_va,
            "test_index": te_all.index, "test_scores": T.score(model, X_all),
            "X_tr": X_tr}


def _reference_stats(per_model_Xtr: dict[str, pd.DataFrame],
                     val_scores: dict[str, np.ndarray]) -> dict:
    """Train-time drift baseline: per model, per feature — 10-quantile bin
    edges + occupancy; plus raw val score deciles. Written to
    models/reference_stats.json as the drift baseline for downstream monitoring."""
    ref = {}
    qs = np.linspace(0, 1, 11)
    for key, X in per_model_Xtr.items():
        feats = {}
        for c in X.columns:
            col = X[c].to_numpy(dtype="float64")
            col = col[~np.isnan(col)]
            if len(col) == 0:
                continue
            edges = np.unique(np.quantile(col, qs))
            hist = (np.histogram(col, bins=edges)[0] if len(edges) > 1
                    else np.array([len(col)]))
            freq = hist / max(hist.sum(), 1)
            feats[c] = {"edges": [float(e) for e in edges],
                        "freq": [round(float(f), 6) for f in freq]}
        ref[key] = {"features": feats,
                    "score_deciles": [float(v) for v in
                                      np.quantile(val_scores[key], qs)]}
    return ref


def run(df: pd.DataFrame | None = None, *, models_dir=MODELS, reports_dir=ML_REPORTS,
        fast: bool = False, skip_shap: bool = False) -> dict:
    np.random.seed(SEED)
    t0 = time.perf_counter()
    stage_times: dict[str, float] = {}
    models_dir.mkdir(parents=True, exist_ok=True)
    reports_dir.mkdir(parents=True, exist_ok=True)

    print("== load + split ==")
    if df is None:
        df = D.load_engineered()
    split = D.temporal_split(df)
    manifest = D.write_split_manifest(df, split, reports_dir=reports_dir)
    stage_times["load_split_s"] = round(time.perf_counter() - t0, 1)
    print(f"rows={len(df):,}  {stage_times}")

    engine = RiskFusionEngine(FUSION_WEIGHTS)
    all_metrics: dict[str, dict] = {}
    test_scores = pd.DataFrame(index=df.index, columns=list(MODEL_LIB), dtype="float64")
    per_model_Xtr: dict[str, pd.DataFrame] = {}
    val_scores: dict[str, np.ndarray] = {}

    for key in MODEL_LIB:
        ts = time.perf_counter()
        print(f"== {key} ({MODEL_LIB[key]}) ==")
        r = train_one(key, df, split, models_dir=models_dir, reports_dir=reports_dir,
                      fast=fast, skip_shap=skip_shap)
        print(f"  test: {r['metrics']['test']}")
        engine.fit_calibrator(key, r["s_va"], r["y_va"])
        test_scores.loc[r["test_index"], key] = r["test_scores"]
        per_model_Xtr[key] = r["X_tr"]
        val_scores[key] = r["s_va"]
        all_metrics[key] = r["metrics"]
        stage_times[f"{key}_s"] = round(time.perf_counter() - ts, 1)

    # ------------------------------------------------------------- fusion ----
    print("== fusion ==")
    ts = time.perf_counter()
    joblib.dump(engine, models_dir / "fusion_engine.joblib", compress=3)

    test_mask = (split == "test") & test_scores.notna().any(axis=1)
    fused = engine.fuse_frame(test_scores.loc[test_mask])
    lab = df.loc[test_mask, "label"]
    labeled = lab >= 0
    from sklearn.metrics import roc_auc_score
    fusion_auc = float(roc_auc_score(lab[labeled], fused.loc[labeled, "risk_score"]))

    plt.figure(figsize=(7, 4))
    for lv, grp in fused.groupby("risk_level", observed=True):
        plt.hist(grp["risk_score"], bins=40, alpha=0.6, label=lv)
    plt.xlabel("fused risk score"); plt.ylabel("events"); plt.yscale("log")
    plt.title("Risk Fusion Engine — test set"); plt.legend()
    plt.tight_layout(); plt.savefig(reports_dir / "fusion_risk_hist.png", dpi=110)
    plt.close("all")

    example = engine.fuse({"fraud_payment": 0.92, "behaviour": 0.1})
    fusion_report = {
        "weights": FUSION_WEIGHTS,
        "calibration": "isotonic per model, fitted on validation",
        "combiner": "weighted noisy-OR: 1 - prod(1 - w_i * p_i)",
        "test_events_fused": int(len(fused)),
        "cross_domain_roc_auc_labeled_test": round(fusion_auc, 4),
        "risk_level_distribution": fused["risk_level"].value_counts().to_dict(),
        "example_multi_signal": {"input": {"fraud_payment": 0.92, "behaviour": 0.1},
                                 "output": example},
    }
    (reports_dir / "fusion_report.json").write_text(json.dumps(fusion_report, indent=2))
    all_metrics["fusion"] = {"cross_domain_roc_auc": round(fusion_auc, 4),
                             "test_events_fused": int(len(fused))}
    print(f"  fusion AUC={fusion_auc:.4f}  levels={fusion_report['risk_level_distribution']}")
    stage_times["fusion_s"] = round(time.perf_counter() - ts, 1)

    # ---------------------------------------------- drift reference stats ----
    (models_dir / "reference_stats.json").write_text(
        json.dumps(_reference_stats(per_model_Xtr, val_scores), indent=2))

    # ----------------------------------------------------------- manifest ----
    import lightgbm
    import sklearn
    import xgboost
    run_manifest = {
        "seed": SEED,
        "data": {"file": str(D.ENGINEERED_PARQUET.name), "rows": manifest["rows_total"],
                 "split_rule": manifest["rule"]},
        "fast_mode": fast,
        "versions": {"python": platform.python_version(),
                     "pandas": pd.__version__, "numpy": np.__version__,
                     "sklearn": sklearn.__version__, "xgboost": xgboost.__version__,
                     "lightgbm": lightgbm.__version__},
        "params": {"xgb": {k: v for k, v in XGB_PARAMS.items() if k != "n_jobs"},
                   "lgbm": {k: v for k, v in LGBM_PARAMS.items() if k != "n_jobs"},
                   "iforest": {k: v for k, v in IFOREST_PARAMS.items() if k != "n_jobs"}},
        "features": FEATURES,
        "stage_times_s": stage_times,
        "total_s": round(time.perf_counter() - t0, 1),
    }
    (reports_dir / "run_manifest.json").write_text(json.dumps(run_manifest, indent=2))
    (reports_dir / "metrics_all.json").write_text(json.dumps(all_metrics, indent=2))

    print(f"== done in {run_manifest['total_s']}s ==")
    return all_metrics


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true", help="tiny models (smoke/test)")
    ap.add_argument("--skip-shap", action="store_true")
    a = ap.parse_args()
    run(fast=a.fast, skip_shap=a.skip_shap)
