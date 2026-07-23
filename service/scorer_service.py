"""Thin wrapper holding the loaded SentinelScorer and mapping DataFrame rows to
the API response shape. Loaded once at startup; immutable and thread-safe for
concurrent scoring (no per-request mutation)."""
from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Mapping

import pandas as pd

from ml.predict import SentinelScorer

_P_COLS = ["p_fraud", "p_cyber", "p_behaviour", "p_quantum"]


def _clean(v: Any) -> Any:
    """NaN/NA -> None for JSON; numpy scalars -> Python floats."""
    if v is None:
        return None
    try:
        if isinstance(v, float) and math.isnan(v):
            return None
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return v


class ScorerService:
    def __init__(self, models_dir: Path, *, version: str = "dev") -> None:
        self.scorer = SentinelScorer(models_dir, version=version)
        self.version = version

    def score(self, events: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
        """events: raw event dicts already merged with engineered f_* features."""
        df = pd.DataFrame(list(events))
        if "event_domain" not in df.columns:
            raise ValueError("event_domain missing")
        out = self.scorer.score_events(df)
        rows: list[dict[str, Any]] = []
        for i, (_, r) in enumerate(out.iterrows()):
            rows.append({
                "event_id": events[i].get("event_id"),
                "model": _clean(r["model"]),
                "raw_score": _clean(float(r["raw_score"]) if pd.notna(r["raw_score"])
                                    else None),
                "risk_score": float(r["risk_score"]),
                "risk_level": str(r["risk_level"]),
                "scored": bool(r["scored"]),
                "contributions": {c: _clean(r.get(c)) for c in _P_COLS},
                "model_version": self.version,
            })
        return rows
