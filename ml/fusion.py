"""Risk Fusion Engine — combines per-model outputs into one risk score.

Design (deliberately lightweight, CPU-only, no extra model):
  1. Calibrate: raw model score -> P(malicious) via isotonic regression fitted
     on validation. Makes heterogeneous outputs (GBM probability, IsolationForest
     anomaly score) comparable on one probability scale.
  2. Combine: weighted noisy-OR   risk = 1 - prod_i(1 - w_i * p_i)
     Any single confident signal dominates (union-of-threats semantics);
     independent weak signals accumulate. Missing signals are simply skipped,
     so single-domain events score correctly.
  3. Band: low / medium / high / critical.

fuse() is the online single-event API; fuse_frame() the vectorized batch path.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

from .config import FUSION_WEIGHTS, RISK_BANDS


class RiskFusionEngine:
    def __init__(self, weights: dict[str, float] | None = None):
        self.weights = dict(weights or FUSION_WEIGHTS)
        self.calibrators: dict[str, IsotonicRegression] = {}

    # ------------------------------------------------------------ fitting ----
    def fit_calibrator(self, model_key: str, s_val: np.ndarray,
                       y_val: np.ndarray) -> None:
        iso = IsotonicRegression(y_min=0.0, y_max=1.0, increasing=True,
                                 out_of_bounds="clip")
        iso.fit(s_val, y_val)
        self.calibrators[model_key] = iso

    def calibrate(self, model_key: str, s) -> np.ndarray:
        return self.calibrators[model_key].predict(np.atleast_1d(np.asarray(s, dtype="float64")))

    # ---------------------------------------------------------- inference ----
    def fuse(self, signals: dict[str, float]) -> dict:
        """signals: {model_key: raw score}. Unknown keys rejected, NaN skipped."""
        unknown = set(signals) - set(self.weights)
        if unknown:
            raise KeyError(f"unknown signal(s): {sorted(unknown)}")
        contributions = {}
        survive = 1.0
        for k, s in signals.items():
            if s is None or (isinstance(s, float) and np.isnan(s)):
                continue
            p = float(self.calibrate(k, s)[0])
            c = self.weights[k] * p
            contributions[k] = round(c, 4)
            survive *= 1.0 - c
        risk = 1.0 - survive
        return {"risk_score": round(risk, 4), "risk_level": self.band(risk),
                "contributions": contributions}

    def fuse_frame(self, scores: pd.DataFrame) -> pd.DataFrame:
        """scores: one column per model_key, NaN = signal absent for that event."""
        survive = np.ones(len(scores))
        out = pd.DataFrame(index=scores.index)
        for k in scores.columns:
            s = scores[k].to_numpy(dtype="float64")
            m = ~np.isnan(s)
            c = np.zeros(len(s))
            if m.any():
                c[m] = self.weights[k] * self.calibrate(k, s[m])
            out[f"p_{k}"] = np.where(m, c, np.nan)
            survive *= 1.0 - c
        out["risk_score"] = 1.0 - survive
        out["risk_level"] = pd.cut(
            out["risk_score"], [-0.01, *[b for b, _ in RISK_BANDS]],
            labels=[lvl for _, lvl in RISK_BANDS]).astype(str)
        return out

    @staticmethod
    def band(risk: float) -> str:
        for bound, level in RISK_BANDS:
            if risk < bound:
                return level
        return RISK_BANDS[-1][1]
