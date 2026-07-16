"""Per-model feature matrices + persistable categorical encoding.

CategoryEncoder: ordinal codes learned on train only, saved as plain JSON in
the model bundle. Unseen/missing category at inference -> -1. Same numeric
matrix feeds XGBoost, LightGBM and IsolationForest (IForest additionally gets
median imputation — sklearn trees reject NaN).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import FEATURES


class CategoryEncoder:
    """Ordinal encoder with frozen train-time vocabulary. JSON-serializable."""

    def __init__(self, mapping: dict[str, dict[str, int]] | None = None):
        self.mapping = mapping or {}

    def fit(self, df: pd.DataFrame, cols: list[str]) -> "CategoryEncoder":
        for c in cols:
            cats = pd.Series(df[c].dropna().unique()).astype(str).sort_values()
            self.mapping[c] = {v: i for i, v in enumerate(cats)}
        return self

    def transform(self, df: pd.DataFrame) -> pd.DataFrame:
        out = {}
        for c, m in self.mapping.items():
            s = df[c].astype(str) if c in df.columns else pd.Series("", index=df.index)
            out[c] = s.map(m).fillna(-1).astype("float32")
        return pd.DataFrame(out, index=df.index)


def build_matrix(df: pd.DataFrame, model_key: str,
                 encoder: CategoryEncoder | None = None
                 ) -> tuple[pd.DataFrame, CategoryEncoder]:
    """X (float32, NaN preserved) for one model. Fits encoder when not given."""
    spec = FEATURES[model_key]
    num = df.reindex(columns=spec["numeric"]).astype("float32")
    if encoder is None:
        encoder = CategoryEncoder().fit(df, spec["categorical"])
    cat = encoder.transform(df)
    X = pd.concat([num, cat], axis=1)
    return X, encoder


def fit_imputer(X: pd.DataFrame) -> dict[str, float]:
    """Train-split medians (0.0 for all-NaN columns) — IsolationForest input."""
    med = X.median(numeric_only=True)
    return {c: float(med[c]) if pd.notna(med[c]) else 0.0 for c in X.columns}


def impute(X: pd.DataFrame, medians: dict[str, float]) -> pd.DataFrame:
    return X.fillna(pd.Series(medians, dtype="float32"))


def labels_and_weights(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    y = df["label"].to_numpy(dtype="int8")
    w = df["sampling_weight"].fillna(1.0).to_numpy(dtype="float64")
    return y, w
