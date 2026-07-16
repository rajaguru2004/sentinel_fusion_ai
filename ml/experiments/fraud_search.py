"""Experiment A — fraud XGBoost small randomized search + cost threshold.

    python -m ml.experiments.fraud_search

24 sampled configs (seed 42), selected on VAL PR-AUC (positives 4.2% — PR
beats ROC/F1 there). Then a cost-sensitive threshold on the population-
weighted val distribution (c_fn = 20 x c_fp) — attacks the weighted-precision
0.046 problem: max-F1 on the capped corpus fires ~62K FP/M benign in
population terms. Winner saved as challenger bundle; promotion via
`ml.benchmark --challenger`.
"""
from __future__ import annotations

import numpy as np
from sklearn.model_selection import ParameterSampler

from ..config import COST, SEED
from ..evaluate import pick_threshold_cost
from ..train import score, train_xgb
from .common import eval_scores, save_report, slices, timed, write_challenger

GRID = {
    "max_depth": [4, 5, 6, 8],
    "learning_rate": [0.03, 0.05, 0.1],
    "min_child_weight": [1, 5, 20],
    "subsample": [0.6, 0.8, 1.0],
    "colsample_bytree": [0.6, 0.8, 1.0],
}
N_ITER = 24


def main() -> None:
    sl = slices("fraud", labeled_train=True)
    X, y = sl["X"], sl["y"]

    rows = []
    best = None
    for i, params in enumerate(ParameterSampler(GRID, n_iter=N_ITER,
                                                random_state=SEED)):
        params = {**params, "n_estimators": 800}  # early stopping trims
        model, secs = timed(train_xgb, X["train"], y["train"],
                            X["val"], y["val"], params)
        m = eval_scores(y["val"], score(model, X["val"]))
        rows.append({"config": params, "val": m, "fit_s": secs,
                     "best_iteration": int(model.best_iteration)})
        if best is None or m["pr_auc"] > best["val"]["pr_auc"]:
            best = {**rows[-1], "model": model}
        print(f"[{i + 1:2d}/{N_ITER}] val_pr_auc={m['pr_auc']:.4f}  {params}")

    model = best["model"]
    s_va, s_te = score(model, X["val"]), score(model, X["test"])
    cost_thr, curve = pick_threshold_cost(
        y["val"], s_va, c_fp=COST["fraud"]["c_fp"], c_fn=COST["fraud"]["c_fn"],
        weights=sl["w_va"])
    challenger = write_challenger("fraud", model, sl, "xgboost", None, s_va)

    save_report("fraud_search", {
        "n_configs": N_ITER, "objective": "val pr_auc",
        "winner_config": best["config"],
        "winner_val": best["val"],
        "winner_test": eval_scores(y["test"], s_te),
        "cost_threshold": {"c_fp": COST["fraud"]["c_fp"],
                           "c_fn": COST["fraud"]["c_fn"],
                           "threshold": round(float(cost_thr), 6),
                           "curve_every_10th": curve[::10]},
        "challenger_bundle": str(challenger),
        "all_configs": [{k: v for k, v in r.items() if k != "model"} for r in rows],
    })
    print(f"winner val={best['val']}  test={eval_scores(y['test'], s_te)}")
    print(f"cost threshold (population-weighted, fn={COST['fraud']['c_fn']}x): "
          f"{cost_thr:.4f}")


if __name__ == "__main__":
    np.random.seed(SEED)
    main()
