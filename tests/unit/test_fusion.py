import numpy as np
import pandas as pd
import pytest

from ml.fusion import RiskFusionEngine

W = {"fraud": 1.0, "cyber": 1.0, "behaviour": 0.7, "quantum": 0.9}


@pytest.fixture
def engine():
    """Identity calibrators: score in [0,1] calibrates to itself."""
    e = RiskFusionEngine(W)
    grid = np.linspace(0, 1, 101)
    for k in W:
        e.fit_calibrator(k, grid, grid)
    return e


def test_noisy_or_single_signal_equals_weighted_p(engine):
    r = engine.fuse({"fraud": 0.5})
    assert r["risk_score"] == pytest.approx(1.0 * 0.5, abs=1e-6)


def test_noisy_or_two_signals_matches_closed_form(engine):
    r = engine.fuse({"fraud": 0.4, "quantum": 0.6})
    expected = 1 - (1 - 1.0 * 0.4) * (1 - 0.9 * 0.6)
    assert r["risk_score"] == pytest.approx(expected, abs=1e-6)
    assert set(r["contributions"]) == {"fraud", "quantum"}


def test_missing_nan_none_signals_skipped(engine):
    base = engine.fuse({"cyber": 0.3})["risk_score"]
    assert engine.fuse({"cyber": 0.3, "fraud": float("nan")})["risk_score"] == base
    assert engine.fuse({"cyber": 0.3, "fraud": None})["risk_score"] == base


def test_unknown_signal_raises_keyerror(engine):
    with pytest.raises(KeyError):
        engine.fuse({"volcano": 0.9})


def test_all_signals_absent_risk_zero_band_low(engine):
    r = engine.fuse({})
    assert r["risk_score"] == 0.0
    assert r["risk_level"] == "low"


def test_risk_never_exceeds_one(engine):
    r = engine.fuse({"fraud": 1.0, "cyber": 1.0, "quantum": 1.0, "behaviour": 1.0})
    assert r["risk_score"] <= 1.0
    assert r["risk_level"] == "critical"


def test_behaviour_alone_capped_at_weight(engine):
    r = engine.fuse({"behaviour": 1.0})
    assert r["risk_score"] == pytest.approx(0.7, abs=1e-6)
    assert r["risk_level"] == "high"  # can never reach critical alone


def test_band_boundaries_exact(engine):
    assert engine.band(0.0) == "low"
    assert engine.band(0.25) == "medium"
    assert engine.band(0.50) == "high"
    assert engine.band(0.75) == "critical"
    assert engine.band(1.0) == "critical"


def test_fuse_frame_agrees_with_scalar_fuse_on_boundaries(engine):
    # regression for pd.cut right-closed bug: 0.25 banded "low" in batch path
    scores = pd.DataFrame({"fraud": [0.25, 0.50, 0.75, 0.10, np.nan],
                           "cyber": [np.nan] * 5,
                           "behaviour": [np.nan] * 5,
                           "quantum": [np.nan, np.nan, np.nan, np.nan, 0.30]})
    out = engine.fuse_frame(scores)
    for i in range(len(scores)):
        sig = {k: v for k, v in scores.iloc[i].items() if pd.notna(v)}
        assert out["risk_level"].iloc[i] == engine.fuse(sig)["risk_level"], i
        assert out["risk_score"].iloc[i] == pytest.approx(
            engine.fuse(sig)["risk_score"], abs=1e-9)


def test_calibrator_clipped_and_monotone(engine):
    e = RiskFusionEngine({"fraud": 1.0})
    rng = np.random.default_rng(0)
    s = rng.normal(size=500)
    y = (s + rng.normal(scale=0.5, size=500) > 0).astype(int)
    e.fit_calibrator("fraud", s, y)
    p = e.calibrate("fraud", np.sort(s))
    assert (p >= 0).all() and (p <= 1).all()
    assert (np.diff(p) >= -1e-12).all()  # non-decreasing
    lo, hi = e.calibrate("fraud", s.min() - 100), e.calibrate("fraud", s.max() + 100)
    assert 0 <= lo[0] <= 1 and 0 <= hi[0] <= 1  # out_of_bounds clip


def test_fuse_missing_calibrator_clear_error():
    e = RiskFusionEngine(W)  # nothing fitted
    with pytest.raises(RuntimeError, match="no calibrator fitted for 'fraud'"):
        e.fuse({"fraud": 0.5})
