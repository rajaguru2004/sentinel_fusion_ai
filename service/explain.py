"""On-demand single-event SHAP attribution (``?explain=true``).

Mirrors demo/engine.py::_predict_one/_explain_one but returns JSON, no plotting.
SHAP (the ``train`` extra) is imported lazily so the base serving image never
needs it unless explanations are enabled.
"""
from __future__ import annotations

from typing import Any, Mapping

import numpy as np
import pandas as pd

from ml.config import route
from ml.features import CategoryEncoder, build_matrix, impute

from .reasons import describe


def _raw_value(ev: Mapping[str, Any], feature: str, encoded: float | None):
    """Prefer the event's own value for a feature over the encoded matrix cell.

    The matrix holds ordinal codes for categoricals and median-imputed values
    for IsolationForest paths, so reason templates must read the raw event
    (which already carries the merged engineered f_* features).
    """
    v = ev.get(feature)
    return encoded if v is None else v


class Explainer:
    """Caches one shap.TreeExplainer per model, built on first use."""

    def __init__(self, scorer, top_k: int = 7) -> None:
        self._bundles = scorer.bundles
        self._top_k = top_k
        self._explainers: dict[str, Any] = {}

    def _get(self, key: str):
        if key not in self._explainers:
            import shap
            self._explainers[key] = shap.TreeExplainer(self._bundles[key]["model"])
        return self._explainers[key]

    def explain(self, ev: Mapping[str, Any]) -> dict[str, Any] | None:
        # Route exactly as the scorer does. Inverting DOMAIN_OF_MODEL is WRONG
        # now that two heads share the financial domain: the later key silently
        # wins, so every financial event got explained by fraud_application
        # regardless of which head actually scored it.
        key = route(ev.get("event_domain"), ev.get("event_type"))
        if key is None:
            return None
        b = self._bundles[key]
        row = pd.DataFrame([dict(ev)])
        X, _ = build_matrix(row, key, CategoryEncoder(b["encoder_mapping"]))
        X = X[b["features"]]
        if b["medians"] is not None:
            X = impute(X, b["medians"])
        sv = self._get(key).shap_values(X, check_additivity=False)
        if isinstance(sv, list):
            sv = sv[1]
        if sv.ndim == 3:
            sv = sv[:, :, 1]
        v = sv[0]
        ranked = np.argsort(-np.abs(v))
        order = ranked[:self._top_k]
        feats = [{
            "feature": X.columns[i],
            "value": None if pd.isna(X.iloc[0, i]) else round(float(X.iloc[0, i]), 4),
            "shap": round(float(v[i]), 4),
        } for i in order]
        # `top_features` stays the top-k by |SHAP| (the machine-readable view),
        # but reasons are drawn from EVERY positively-contributing feature: the
        # most explainable signal is often not the biggest one. `amount` ranks
        # first and only yields "unusual transaction amount", while
        # f_amount_ratio_mean ranks lower and yields "amount is 12x this
        # customer's normal spend".
        #
        # Values come from the RAW event, not the encoded matrix — X holds
        # ordinal codes for categoricals and median-imputed cells.
        pool = [{
            "feature": X.columns[i],
            "value": _raw_value(ev, X.columns[i],
                                None if pd.isna(X.iloc[0, i])
                                else float(X.iloc[0, i])),
            "shap": float(v[i]),
        } for i in ranked if v[i] > 0]
        return {"model": key, "top_features": feats, "reasons": describe(pool)}
