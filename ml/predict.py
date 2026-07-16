"""Online inference — load serialized bundles, score events, fuse risk.

    .venv/bin/python -m ml.predict          # demo on a few test events

SentinelScorer is the deployment-facing API: give it a dataframe of unified
events (raw columns, NaNs fine) and it routes each row to its domain model,
returns per-model scores + fused risk. CPU-only, no training deps at runtime.
"""
from __future__ import annotations

import joblib
import numpy as np
import pandas as pd

from .config import DOMAIN_OF_MODEL, MODELS
from .features import CategoryEncoder, build_matrix, impute


class SentinelScorer:
    def __init__(self, models_dir=MODELS):
        self.bundles = {k: joblib.load(models_dir / f"{k}_bundle.joblib")
                        for k in DOMAIN_OF_MODEL}
        self.fusion = joblib.load(models_dir / "fusion_engine.joblib")

    def score_events(self, events: pd.DataFrame) -> pd.DataFrame:
        """events: unified-schema rows (quantum rows need q_* attrs columns).
        Returns raw score, calibrated probability, fused risk + level per row."""
        scores = pd.DataFrame(index=events.index,
                              columns=list(DOMAIN_OF_MODEL), dtype="float64")
        for key, domain in DOMAIN_OF_MODEL.items():
            rows = events[events["event_domain"] == domain]
            if rows.empty:
                continue
            b = self.bundles[key]
            X, _ = build_matrix(rows, key, CategoryEncoder(b["encoder_mapping"]))
            X = X[b["features"]]
            if b["medians"] is not None:
                X = impute(X, b["medians"])
            m = b["model"]
            s = (m.predict_proba(X)[:, 1] if hasattr(m, "predict_proba")
                 else -m.decision_function(X))
            scores.loc[rows.index, key] = s
        fused = self.fusion.fuse_frame(scores)
        fused.insert(0, "model", scores.notna().idxmax(axis=1).where(scores.notna().any(axis=1)))
        fused.insert(1, "raw_score", scores.bfill(axis=1).iloc[:, 0])
        return fused


if __name__ == "__main__":
    from . import data as D
    df = D.load_engineered()
    split = D.temporal_split(df)
    demo = (df[split == "test"].groupby("event_domain", observed=True)
            .head(3).sample(frac=1, random_state=0))
    out = SentinelScorer().score_events(demo)
    print(pd.concat([demo[["event_domain", "source_dataset", "label"]], out], axis=1)
          .to_string(max_cols=12))
