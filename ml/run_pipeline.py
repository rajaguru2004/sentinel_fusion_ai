"""End-to-end training pipeline.

    .venv/bin/python -m ml.run_pipeline

Stages: load -> split -> per model (features -> train -> threshold on val ->
metrics on test -> latency -> SHAP -> serialize) -> fusion engine (calibrate
on val, fuse test set) -> manifest.

Artifacts:
    models/<key>_bundle.joblib      model + encoder + medians + threshold + features
    models/fraud_xgb.json, cyber_lgbm.txt, quantum_xgb.json   native boosters
    models/fusion_engine.joblib
    reports/ml/metrics_<key>.json, shap_<key>_*.{png,json},
    reports/ml/fusion_report.json, fusion_risk_hist.png,
    reports/ml/split_manifest.json, run_manifest.json, metrics_all.json
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
from .config import (FEATURES, FUSION_WEIGHTS, IFOREST_PARAMS, LGBM_PARAMS,
                     ML_REPORTS, MODELS, SEED, XGB_PARAMS)
from .evaluate import compute_metrics, latency_benchmark, pick_threshold
from .explain import shap_report
from .fusion import RiskFusionEngine

MODEL_LIB = {"fraud": "xgboost", "cyber": "lightgbm",
             "behaviour": "isolation_forest", "quantum": "xgboost"}


def run() -> dict:
    np.random.seed(SEED)
    t0 = time.perf_counter()
    stage_times: dict[str, float] = {}

    print("== load + split ==")
    df = D.load_engineered()
    split = D.temporal_split(df)
    manifest = D.write_split_manifest(df, split)
    stage_times["load_split_s"] = round(time.perf_counter() - t0, 1)
    print(f"rows={len(df):,}  {stage_times}")

    engine = RiskFusionEngine(FUSION_WEIGHTS)
    all_metrics: dict[str, dict] = {}
    test_scores = pd.DataFrame(index=df.index, columns=list(MODEL_LIB), dtype="float64")

    for key in MODEL_LIB:
        ts = time.perf_counter()
        print(f"== {key} ({MODEL_LIB[key]}) ==")
        supervised = key != "behaviour"

        tr = D.domain_slice(df, split, key, "train", labeled_only=supervised)
        va = D.domain_slice(df, split, key, "val", labeled_only=True)
        te = D.domain_slice(df, split, key, "test", labeled_only=True)

        X_tr, enc = F.build_matrix(tr, key)
        X_va, _ = F.build_matrix(va, key, enc)
        X_te, _ = F.build_matrix(te, key, enc)
        y_tr, _ = F.labels_and_weights(tr)
        y_va, _ = F.labels_and_weights(va)
        y_te, w_te = F.labels_and_weights(te)

        medians = None
        if key == "behaviour":
            medians = F.fit_imputer(X_tr)
            X_tr, X_va, X_te = (F.impute(x, medians) for x in (X_tr, X_va, X_te))
            model = T.train_iforest(X_tr)
        elif key == "cyber":
            model = T.train_lgbm(X_tr, y_tr, X_va, y_va)
        else:
            model = T.train_xgb(X_tr, y_tr, X_va, y_va)

        s_va, s_te = T.score(model, X_va), T.score(model, X_te)
        threshold = pick_threshold(y_va, s_va)
        metrics = {
            "model": key, "library": MODEL_LIB[key],
            "rows": {"train": int(len(tr)), "val": int(len(va)), "test": int(len(te))},
            "positive_rate_train": round(float((y_tr == 1).mean()), 4),
            "threshold_val_maxF1": round(threshold, 6),
            "test": compute_metrics(y_te, s_te, threshold),
            "test_population_weighted": compute_metrics(y_te, s_te, threshold, w_te),
            "latency": latency_benchmark(model, X_te),
        }
        if supervised:
            best_it = getattr(model, "best_iteration", None) or getattr(model, "best_iteration_", None)
            metrics["best_iteration"] = int(best_it) if best_it else None

        print(f"  test: {metrics['test']}")
        print(f"  latency: {metrics['latency']['single_row_ms']}")
        metrics["shap_top_features"] = shap_report(model, X_te, key)

        engine.fit_calibrator(key, s_va, y_va)

        bundle = {"model": model, "features": list(X_tr.columns),
                  "encoder_mapping": enc.mapping, "medians": medians,
                  "threshold": threshold, "library": MODEL_LIB[key], "seed": SEED}
        joblib.dump(bundle, MODELS / f"{key}_bundle.joblib", compress=3)
        if MODEL_LIB[key] == "xgboost":
            model.get_booster().save_model(MODELS / f"{key}_xgb.json")
        elif MODEL_LIB[key] == "lightgbm":
            model.booster_.save_model(str(MODELS / f"{key}_lgbm.txt"))

        (ML_REPORTS / f"metrics_{key}.json").write_text(json.dumps(metrics, indent=2))
        all_metrics[key] = metrics

        # scores for every test-split row of this domain (incl. unlabeled) -> fusion demo
        te_all = D.domain_slice(df, split, key, "test", labeled_only=False)
        X_all, _ = F.build_matrix(te_all, key, enc)
        if medians is not None:
            X_all = F.impute(X_all, medians)
        test_scores.loc[te_all.index, key] = T.score(model, X_all)
        stage_times[f"{key}_s"] = round(time.perf_counter() - ts, 1)

    # ------------------------------------------------------------- fusion ----
    print("== fusion ==")
    ts = time.perf_counter()
    joblib.dump(engine, MODELS / "fusion_engine.joblib", compress=3)

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
    plt.tight_layout(); plt.savefig(ML_REPORTS / "fusion_risk_hist.png", dpi=110)
    plt.close("all")

    example = engine.fuse({"fraud": 0.92, "behaviour": 0.1})
    fusion_report = {
        "weights": FUSION_WEIGHTS,
        "calibration": "isotonic per model, fitted on validation",
        "combiner": "weighted noisy-OR: 1 - prod(1 - w_i * p_i)",
        "test_events_fused": int(len(fused)),
        "cross_domain_roc_auc_labeled_test": round(fusion_auc, 4),
        "risk_level_distribution": fused["risk_level"].value_counts().to_dict(),
        "example_multi_signal": {"input": {"fraud": 0.92, "behaviour": 0.1},
                                 "output": example},
    }
    (ML_REPORTS / "fusion_report.json").write_text(json.dumps(fusion_report, indent=2))
    print(f"  fusion AUC={fusion_auc:.4f}  levels={fusion_report['risk_level_distribution']}")
    stage_times["fusion_s"] = round(time.perf_counter() - ts, 1)

    # ----------------------------------------------------------- manifest ----
    import lightgbm, shap, sklearn, xgboost
    run_manifest = {
        "seed": SEED,
        "data": {"file": str(D.ENGINEERED_PARQUET.name), "rows": manifest["rows_total"],
                 "split_rule": manifest["rule"]},
        "versions": {"python": platform.python_version(),
                     "pandas": pd.__version__, "numpy": np.__version__,
                     "sklearn": sklearn.__version__, "xgboost": xgboost.__version__,
                     "lightgbm": lightgbm.__version__, "shap": shap.__version__},
        "params": {"xgb": {k: v for k, v in XGB_PARAMS.items() if k != "n_jobs"},
                   "lgbm": {k: v for k, v in LGBM_PARAMS.items() if k != "n_jobs"},
                   "iforest": {k: v for k, v in IFOREST_PARAMS.items() if k != "n_jobs"}},
        "features": FEATURES,
        "stage_times_s": stage_times,
        "total_s": round(time.perf_counter() - t0, 1),
    }
    (ML_REPORTS / "run_manifest.json").write_text(json.dumps(run_manifest, indent=2))
    (ML_REPORTS / "metrics_all.json").write_text(json.dumps(all_metrics, indent=2))
    print(f"== done in {run_manifest['total_s']}s ==")
    return all_metrics


if __name__ == "__main__":
    run()
