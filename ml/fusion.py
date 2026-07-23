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
        # model_key -> [(upper_bound, level), ...]; empty = use global RISK_BANDS
        self.bands: dict[str, list[tuple[float, str]]] = {}

    # -------------------------------------------------------------- bands ----
    def fit_bands(self, model_key: str, risk: np.ndarray, y: np.ndarray,
                  weights: np.ndarray | None = None) -> list[tuple[float, str]]:
        """Fit band cut points on FUSED validation risk for one model.

        Each boundary is the cost-optimal threshold at a different c_fn/c_fp
        ratio (``config.BAND_COST_RATIOS``), so every band edge corresponds to a
        stated business trade-off rather than a round number. Fitting happens on
        the fused, calibrated risk because that is what the bank actually bands.

        Falls back to the global constants when the slice cannot support a fit
        (single-class or tiny validation set).
        """
        from .config import BAND_COST_RATIOS
        from .evaluate import pick_threshold_cost

        y = np.asarray(y)
        if len(y) < 100 or len(np.unique(y[y >= 0])) < 2:
            return list(RISK_BANDS)

        cuts: dict[str, float] = {}
        for level, ratio in BAND_COST_RATIOS.items():
            t, _ = pick_threshold_cost(y, risk, c_fp=1.0, c_fn=ratio,
                                       weights=weights)
            cuts[level] = float(t)

        # Enforce medium <= high <= critical. The cost curve is not guaranteed
        # monotone in the ratio (ties, plateaus), and a non-monotone band table
        # would make risk_level non-monotone in risk_score — worse than useless.
        m = cuts["medium"]
        h = max(cuts["high"], m)
        c = max(cuts["critical"], h)

        # Collapse case: a sharply bimodal score distribution (isotonic maps to
        # few distinct values) gives the SAME optimum at every cost ratio. The
        # single threshold is still the best information available, so spread
        # the bands around it rather than discarding it — falling back to the
        # 0.25 default would put every one of this model's positives in "low",
        # since its whole score range can sit below 0.25.
        top = float(np.max(risk)) if len(risk) else 1.0
        if m == c:
            m, h, c = 0.5 * h, h, h + 0.5 * (top - h)

        if not (0.0 < m < h < c < 1.0):    # still degenerate -> keep the default
            return list(RISK_BANDS)
        table = [(m, "low"), (h, "medium"), (c, "high"), (1.01, "critical")]
        self.bands[model_key] = table
        return table

    # ------------------------------------------------------------ fitting ----
    def fit_calibrator(self, model_key: str, s_val: np.ndarray,
                       y_val: np.ndarray) -> None:
        iso = IsotonicRegression(y_min=0.0, y_max=1.0, increasing=True,
                                 out_of_bounds="clip")
        iso.fit(s_val, y_val)
        self.calibrators[model_key] = iso

    def calibrate(self, model_key: str, s) -> np.ndarray:
        if model_key not in self.calibrators:
            raise RuntimeError(
                f"no calibrator fitted for '{model_key}' — call fit_calibrator() "
                f"first (fitted: {sorted(self.calibrators)})")
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
        # Band with the cut points of the model that contributed most — routing
        # means one head normally fires, and a payment-fraud 0.06 is not the
        # same verdict as a cyber 0.06.
        dominant = max(contributions, key=contributions.get) if contributions else None
        return {"risk_score": round(risk, 4),
                "risk_level": self.band(risk, dominant),
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
        risk = out["risk_score"].to_numpy()

        # Band per row using the dominant model's fitted cut points. Rows are
        # grouped by model so each group is still a vectorized searchsorted.
        contrib = out[[f"p_{k}" for k in scores.columns]].to_numpy(dtype="float64")
        has = ~np.isnan(contrib).all(axis=1)
        dominant = np.where(has, np.nanargmax(np.where(np.isnan(contrib), -np.inf,
                                                       contrib), axis=1), -1)
        levels_out = np.empty(len(out), dtype=object)
        keys = list(scores.columns)
        for i, key in enumerate(keys):
            m = dominant == i
            if m.any():
                levels_out[m] = self._band_many(risk[m], key)
        rest = dominant < 0
        if rest.any():
            levels_out[rest] = self._band_many(risk[rest], None)
        out["risk_level"] = levels_out
        return out

    def _table(self, model_key: str | None) -> list[tuple[float, str]]:
        return self.bands.get(model_key) or list(RISK_BANDS)

    def _band_many(self, risk: np.ndarray, model_key: str | None) -> np.ndarray:
        table = self._table(model_key)
        # left-closed semantics, same as band(): risk < bound -> level
        bounds = np.array([b for b, _ in table[:-1]])
        levels = np.array([lvl for _, lvl in table])
        return levels[np.searchsorted(bounds, risk, side="right")]

    def band(self, risk: float, model_key: str | None = None) -> str:
        for bound, level in self._table(model_key):
            if risk < bound:
                return level
        return self._table(model_key)[-1][1]
