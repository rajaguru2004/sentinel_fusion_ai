"""Experiment C — calibration method comparison + fusion weight refit.

    python -m ml.experiments.calibration_check

Per model: isotonic (current) vs Platt sigmoid on val — Brier + 10-bin ECE.
Fusion: scipy.optimize refit of noisy-OR weights on val cross-domain log-loss;
adopt only if fused val ROC-AUC improves >= 0.003 (report-only otherwise).
"""
from __future__ import annotations

import joblib
import numpy as np
from scipy.optimize import minimize
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

from ..config import FUSION_WEIGHTS, MODELS, SEED
from ..evaluate import brier_score, expected_calibration_error
from ..features import CategoryEncoder, build_matrix, impute
from ..train import score
from .common import corpus, save_report
from .. import data as D


def _val_scores(key: str, df, split):
    bundle = joblib.load(MODELS / f"{key}_bundle.joblib")
    va = D.domain_slice(df, split, key, "val", labeled_only=True)
    X, _ = build_matrix(va, key, CategoryEncoder(bundle["encoder_mapping"]))
    X = X[bundle["features"]]
    if bundle["medians"] is not None:
        X = impute(X, bundle["medians"])
    return va["label"].to_numpy(), score(bundle["model"], X)


def main() -> None:
    np.random.seed(SEED)
    df, split = corpus()
    report = {"models": {}}
    val = {}

    for key in ["fraud", "cyber", "behaviour", "quantum"]:
        y, s = _val_scores(key, df, split)
        val[key] = (y, s)
        iso = IsotonicRegression(y_min=0, y_max=1, out_of_bounds="clip").fit(s, y)
        sig = LogisticRegression(max_iter=1000).fit(s.reshape(-1, 1), y)
        p_iso = iso.predict(s)
        p_sig = sig.predict_proba(s.reshape(-1, 1))[:, 1]
        report["models"][key] = {
            "isotonic": {"brier": round(brier_score(y, p_iso), 5),
                         "ece": round(expected_calibration_error(y, p_iso), 5)},
            "sigmoid": {"brier": round(brier_score(y, p_sig), 5),
                        "ece": round(expected_calibration_error(y, p_sig), 5)},
        }
        report["models"][key]["winner"] = min(
            ("isotonic", "sigmoid"),
            key=lambda k: report["models"][key][k]["brier"])

    # ---- fusion weight refit on val (event-level: one signal per event) ----
    engine = joblib.load(MODELS / "fusion_engine.joblib")
    keys = list(FUSION_WEIGHTS)
    y_all, p_all, k_idx = [], [], []
    for i, key in enumerate(keys):
        y, s = val[key]
        y_all.append(y)
        p_all.append(engine.calibrate(key, s))
        k_idx.append(np.full(len(y), i))
    y_all = np.concatenate(y_all)
    p_all = np.clip(np.concatenate(p_all), 1e-6, 1 - 1e-6)
    k_idx = np.concatenate(k_idx)

    def nll(w):
        risk = np.clip(w[k_idx] * p_all, 1e-6, 1 - 1e-6)
        return -np.mean(y_all * np.log(risk) + (1 - y_all) * np.log(1 - risk))

    w0 = np.array([FUSION_WEIGHTS[k] for k in keys])
    res = minimize(nll, w0, bounds=[(0.1, 1.0)] * len(keys), method="L-BFGS-B")
    auc_before = roc_auc_score(y_all, w0[k_idx] * p_all)
    auc_after = roc_auc_score(y_all, res.x[k_idx] * p_all)
    report["fusion_weight_refit"] = {
        "current": dict(zip(keys, [round(float(v), 3) for v in w0])),
        "refit": dict(zip(keys, [round(float(v), 3) for v in res.x])),
        "val_auc_current": round(float(auc_before), 4),
        "val_auc_refit": round(float(auc_after), 4),
        "adopt": bool(auc_after - auc_before >= 0.003),
    }
    save_report("calibration_check", report)
    print({k: v["winner"] for k, v in report["models"].items()})
    print(report["fusion_weight_refit"])


if __name__ == "__main__":
    main()
