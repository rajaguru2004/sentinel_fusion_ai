"""SHAP explainability — TreeExplainer on a fixed-seed test sample.

Outputs per model into reports/ml/:
    shap_<model>_summary.png   beeswarm (direction + magnitude)
    shap_<model>_bar.png       mean |SHAP| ranking
    shap_<model>_top_features.json
"""
from __future__ import annotations

import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from .config import ML_REPORTS, SEED, SHAP_SAMPLE


def shap_report(model, X_test: pd.DataFrame, model_key: str,
                reports_dir=None) -> dict:
    import shap

    reports_dir = reports_dir or ML_REPORTS
    Xs = X_test.sample(min(SHAP_SAMPLE, len(X_test)), random_state=SEED)
    explainer = shap.TreeExplainer(model)
    sv = explainer.shap_values(Xs, check_additivity=False)
    if isinstance(sv, list):          # older binary-clf API: [neg, pos]
        sv = sv[1]
    if sv.ndim == 3:                  # (n, features, classes)
        sv = sv[:, :, 1]

    for kind, fname in (("dot", f"shap_{model_key}_summary.png"),
                        ("bar", f"shap_{model_key}_bar.png")):
        plt.figure()
        shap.summary_plot(sv, Xs, plot_type=kind, show=False, max_display=15)
        plt.title(f"{model_key} — SHAP ({kind})")
        plt.tight_layout()
        plt.savefig(reports_dir / fname, dpi=110)
        plt.close("all")

    imp = pd.Series(np.abs(sv).mean(axis=0), index=Xs.columns).sort_values(ascending=False)
    top = {k: round(float(v), 5) for k, v in imp.head(15).items()}
    (reports_dir / f"shap_{model_key}_top_features.json").write_text(
        json.dumps({"model": model_key, "sample_rows": int(len(Xs)),
                    "mean_abs_shap_top15": top}, indent=2))
    return top
