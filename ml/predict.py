"""Online inference — load serialized bundles, score events, fuse risk.

    .venv/bin/python -m ml.predict          # demo on a few test events

SentinelScorer is the deployment-facing API: give it a dataframe of unified
events (raw columns, NaNs fine) and it routes each row to its domain model,
returns per-model scores + fused risk. CPU-only, no training deps at runtime.

Bundles may be injected pre-built via `bundles=` (the service passes the ones it
loaded at startup, after service.app.check_contract has verified their
CONTRACT_HASH matches the running feature contract).
"""
from __future__ import annotations

import joblib
import pandas as pd

from .config import DOMAIN_OF_MODEL, MODELS, route
from .features import CategoryEncoder, build_matrix, impute

REQUIRED_COLUMNS = ["event_domain"]


class SentinelScorer:
    def __init__(self, models_dir=MODELS, *, bundles: dict | None = None,
                 fusion=None, version: str = "dev"):
        self.bundles = bundles or {k: joblib.load(models_dir / f"{k}_bundle.joblib")
                                   for k in DOMAIN_OF_MODEL}
        self.fusion = fusion or joblib.load(models_dir / "fusion_engine.joblib")
        self.version = version

    def score_events(self, events: pd.DataFrame) -> pd.DataFrame:
        """events: unified-schema rows (quantum rows need q_* attrs columns).
        Returns per-row: routed model, raw score, calibrated p_* contributions,
        fused risk_score + risk_level, and `scored` (False when no model covers
        the row's domain, e.g. threat_intel — risk defaults to 0/low)."""
        missing = [c for c in REQUIRED_COLUMNS if c not in events.columns]
        if missing:
            raise ValueError(f"events frame missing required column(s): {missing}")

        scores = pd.DataFrame(index=events.index,
                              columns=list(DOMAIN_OF_MODEL), dtype="float64")
        if len(events):
            # Route on (event_domain, event_type): the financial domain has two
            # heads. v1 routed on domain alone, which forced one fraud model to
            # serve payments and account applications at once.
            et = (events["event_type"] if "event_type" in events.columns
                  else pd.Series([None] * len(events), index=events.index))
            routed = [route(d, t) for d, t in zip(events["event_domain"], et,
                                                  strict=True)]
            routed = pd.Series(routed, index=events.index)
            for key in DOMAIN_OF_MODEL:
                rows = events[routed == key]
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
        has_model = scores.notna().any(axis=1)
        fused.insert(0, "model", scores.notna().idxmax(axis=1).where(has_model))
        fused.insert(1, "raw_score", scores.bfill(axis=1).iloc[:, 0])
        fused["scored"] = has_model
        return fused


if __name__ == "__main__":
    from . import data as D
    df = D.load_engineered()
    split = D.temporal_split(df)
    demo = (df[split == "test"].groupby("event_domain", observed=True)
            .head(3).sample(frac=1, random_state=0))
    out = SentinelScorer().score_events(demo)
    print(pd.concat([demo[["event_domain", "source_dataset", "label"]], out], axis=1)
          .to_string(max_cols=13))
