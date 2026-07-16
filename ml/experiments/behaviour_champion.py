"""Experiment B — behaviour model champion selection.

    python -m ml.experiments.behaviour_champion

Incumbent IsolationForest scores ROC-AUC 0.584 vs rba labels — the weak link.
Candidates (all sklearn/no new dep):
    1. supervised LightGBM on the LABELED behaviour train slice (rba)
    2. tuned IsolationForest (6 configs)
    3. LOF novelty=True on a 50K seeded subsample
    4. ECOD-lite: per-feature train ECDF tail probability, summed -log tails
Champion rule: best val ROC-AUC, beats incumbent by >= 0.02. Written as
challenger bundle for `ml.benchmark --challenger`.

Trade-off pinned in the report: supervised candidate learns rba's account-
takeover signal; unlabeled cert_insider rows still get scores (model
generalization, unmeasurable there) — noted for phase-4 sequence models.
"""
from __future__ import annotations

import numpy as np

from ..config import SEED
from ..evaluate import pick_threshold
from ..features import fit_imputer, impute
from ..train import score, train_iforest, train_lgbm
from .common import eval_scores, save_report, slices, timed, write_challenger


class ECODLite:
    """Per-feature empirical-CDF tail scorer (ECOD, simplified).
    score = mean over features of -log(two-sided tail probability)."""

    def __init__(self):
        self.grids: list[np.ndarray] = []

    def fit(self, X: np.ndarray):
        self.grids = [np.sort(col) for col in X.T]
        return self

    def decision_function(self, X: np.ndarray) -> np.ndarray:
        n = len(self.grids[0])
        logs = np.zeros(X.shape[0])
        for j, grid in enumerate(self.grids):
            rank = np.searchsorted(grid, X[:, j], side="right")
            left = np.clip(rank / n, 1e-6, 1.0)
            right = np.clip(1.0 - (rank - 1) / n, 1e-6, 1.0)
            logs += -np.log(np.minimum(left, right))
        return -(logs / X.shape[1])  # sklearn convention: higher = normal


def main() -> None:
    np.random.seed(SEED)
    sup = slices("behaviour", labeled_train=True)    # rba-labeled train
    uns = slices("behaviour", labeled_train=False)   # + unlabeled cert rows

    med = fit_imputer(uns["X"]["train"])
    Xi = {p: impute(uns["X"][p], med) for p in ("train", "val", "test")}
    y_va, y_te = uns["y"]["val"], uns["y"]["test"]

    results = {}

    # 1. supervised LGBM (LGBM is NaN-native -> raw matrices, no imputation)
    model, secs = timed(train_lgbm, sup["X"]["train"], sup["y"]["train"],
                        sup["X"]["val"], sup["y"]["val"])
    s_va = score(model, sup["X"]["val"])
    results["lgbm_supervised"] = {
        "val": eval_scores(sup["y"]["val"], s_va),
        "test": eval_scores(sup["y"]["test"], score(model, sup["X"]["test"])),
        "fit_s": secs, "candidate": (model, None, s_va, "lightgbm", sup)}

    # 2. tuned IsolationForest
    for ms in (256, 1024, 4096):
        for ne in (300, 500):
            m, secs = timed(train_iforest, Xi["train"],
                            {"max_samples": ms, "n_estimators": ne})
            s = score(m, Xi["val"])
            results[f"iforest_ms{ms}_ne{ne}"] = {
                "val": eval_scores(y_va, s), "fit_s": secs,
                "candidate": (m, med, s, "isolation_forest", uns)}

    # 3. LOF novelty on 50K subsample
    from sklearn.neighbors import LocalOutlierFactor
    sub = Xi["train"].sample(min(50_000, len(Xi["train"])), random_state=SEED)
    lof = LocalOutlierFactor(n_neighbors=35, novelty=True, n_jobs=-1)
    _, secs = timed(lof.fit, sub.to_numpy())
    s = -lof.decision_function(Xi["val"].to_numpy())
    results["lof_50k"] = {"val": eval_scores(y_va, s), "fit_s": secs,
                          "candidate": (lof, med, s, "lof", uns)}

    # 4. ECOD-lite
    ecod = ECODLite()
    _, secs = timed(ecod.fit, Xi["train"].to_numpy())
    s = -ecod.decision_function(Xi["val"].to_numpy())
    results["ecod_lite"] = {"val": eval_scores(y_va, s), "fit_s": secs,
                            "candidate": (ecod, med, s, "ecod_lite", uns)}

    incumbent_auc = 0.5843
    ranked = sorted(results.items(), key=lambda kv: kv[1]["val"]["roc_auc"],
                    reverse=True)
    champ_name, champ = ranked[0]
    promoted = champ["val"]["roc_auc"] >= incumbent_auc + 0.02

    challenger_path = None
    if promoted:
        model, medians, s_va, lib, sl = champ["candidate"]
        challenger_path = str(write_challenger("behaviour", model, sl, lib,
                                               medians, s_va))
        if "test" not in champ:
            X_te = sl["X"]["test"] if medians is None else impute(sl["X"]["test"], medians)
            champ["test"] = eval_scores(y_te, score(model, X_te))

    save_report("behaviour_champion", {
        "incumbent_val_roc_auc": incumbent_auc,
        "ranking": [{ "name": k, "val": v["val"], "fit_s": v["fit_s"],
                      **({"test": v["test"]} if "test" in v else {})}
                    for k, v in ranked],
        "champion": champ_name,
        "champion_beats_incumbent_by": round(
            champ["val"]["roc_auc"] - incumbent_auc, 4),
        "promoted_to_challenger": promoted,
        "challenger_bundle": challenger_path,
        "note": ("supervised candidate trains on rba labels only; cert_insider "
                 "(unlabeled) rows still scored, quality there unmeasured — "
                 "sequence model is the phase-4 answer for insider risk"),
    })
    for k, v in ranked:
        print(f"{k:22s} val={v['val']}  fit={v['fit_s']}s")
    print(f"champion={champ_name} promoted={promoted}")


if __name__ == "__main__":
    main()
