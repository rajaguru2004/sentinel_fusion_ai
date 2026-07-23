"""On-demand single-event SHAP attribution (``?explain=true``).

Mirrors demo/engine.py::_predict_one/_explain_one but returns JSON, no plotting.
SHAP (the ``train`` extra) is imported lazily so the base serving image never
needs it unless explanations are enabled.
"""
from __future__ import annotations

from typing import Any, Mapping

import numpy as np
import pandas as pd

from ml.config import DOMAIN_OF_MODEL
from ml.features import CategoryEncoder, build_matrix, impute

_MODEL_OF_DOMAIN = {v: k for k, v in DOMAIN_OF_MODEL.items()}


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
        key = _MODEL_OF_DOMAIN.get(ev.get("event_domain"))
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
        order = np.argsort(-np.abs(v))[:self._top_k]
        feats = [{
            "feature": X.columns[i],
            "value": None if pd.isna(X.iloc[0, i]) else round(float(X.iloc[0, i]), 4),
            "shap": round(float(v[i]), 4),
        } for i in order]
        return {"model": key, "top_features": feats}
