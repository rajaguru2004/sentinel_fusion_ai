"""Calibration sanity of the fusion engine's per-model isotonic maps,
measured on the REAL validation slice."""
import joblib
import numpy as np
import pytest

from ml import data as D
from ml import features as F
from ml import train as T
from ml.evaluate import brier_score
from ml.features import CategoryEncoder

pytestmark = [pytest.mark.quality, pytest.mark.slow]


@pytest.fixture(scope="module")
def val_scores(real_artifacts, full_frame):
    split = D.temporal_split(full_frame)
    engine = joblib.load(real_artifacts / "fusion_engine.joblib")
    out = {}
    for key in ["fraud", "cyber", "behaviour", "quantum"]:
        bundle = joblib.load(real_artifacts / f"{key}_bundle.joblib")
        va = D.domain_slice(full_frame, split, key, "val", labeled_only=True)
        X, _ = F.build_matrix(va, key, CategoryEncoder(bundle["encoder_mapping"]))
        X = X[bundle["features"]]
        if bundle["medians"] is not None:
            X = F.impute(X, bundle["medians"])
        s = T.score(bundle["model"], X)
        y = va["label"].to_numpy()
        out[key] = (y, s, engine.calibrate(key, s))
    return out


@pytest.mark.parametrize("key", ["fraud", "cyber", "behaviour", "quantum"])
def test_calibrated_mean_approximates_base_rate(val_scores, key):
    y, _, p = val_scores[key]
    assert abs(float(p.mean()) - float((y == 1).mean())) < 0.05, key


@pytest.mark.parametrize("key", ["fraud", "behaviour"])
def test_calibrated_brier_beats_raw_score(val_scores, key):
    # raw GBM probs are distorted by scale_pos_weight; IForest raw isn't a prob
    y, s, p = val_scores[key]
    s01 = (s - s.min()) / max(s.max() - s.min(), 1e-9)  # raw mapped to [0,1]
    assert brier_score(y, p) <= brier_score(y, s01) + 1e-9, key


@pytest.mark.parametrize("key", ["fraud", "cyber", "behaviour", "quantum"])
def test_calibrated_probs_in_unit_interval(val_scores, key):
    _, _, p = val_scores[key]
    assert (p >= 0).all() and (p <= 1).all()
    assert np.isfinite(p).all()
