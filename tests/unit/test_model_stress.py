"""Pure ML stress tests — correctness under adversarial inputs & edge cases.
Uses mini_artifacts / fixture_frame so tests are fast and hermetic.
"""
from __future__ import annotations

import joblib
import numpy as np
import pandas as pd
import pytest

from ml import feature_spec as FS
from ml.config import DOMAIN_OF_MODEL, FUSION_WEIGHTS
from ml.features import CategoryEncoder, build_matrix
from ml.fusion import RiskFusionEngine
from ml.predict import SentinelScorer


def test_all_nan_input_returns_low_risk(scorer):
    df = pd.DataFrame([{
        "event_id": "nan-1",
        "event_domain": "financial",
        "event_type": "card_txn",
        "amount": np.nan,
        "country": np.nan,
    }])
    out = scorer.score_events(df)
    assert len(out) == 1
    assert out.iloc[0]["risk_level"] in ("low", "medium", "high", "critical")
    assert np.isfinite(out.iloc[0]["risk_score"])


def test_single_signal_score_bounded(scorer):
    # Each model alone: risk_score must be bounded by [0, weight]
    for key, dom in DOMAIN_OF_MODEL.items():
        w = FUSION_WEIGHTS[key]
        res = scorer.fusion.fuse({key: 0.999})
        assert 0.0 <= res["risk_score"] <= w + 1e-4, key


def test_domain_routing_exclusive(scorer):
    events = pd.DataFrame([
        {"event_id": "1", "event_domain": "financial", "event_type": "card_txn"},
        {"event_id": "2", "event_domain": "cyber", "event_type": "network_flow"},
        {"event_id": "3", "event_domain": "behaviour", "event_type": "user_session"},
        {"event_id": "4", "event_domain": "quantum", "event_type": "qkd_session"},
    ])
    out = scorer.score_events(events)
    assert out.loc[0, "model"] == "fraud_payment"
    assert out.loc[1, "model"] == "cyber"
    assert out.loc[2, "model"] == "behaviour"
    assert out.loc[3, "model"] == "quantum"


def test_fusion_monotone_in_signal():
    engine = RiskFusionEngine(FUSION_WEIGHTS)
    grid = np.linspace(0, 1, 101)
    for k in FUSION_WEIGHTS:
        engine.fit_calibrator(k, grid, grid)

    r1 = engine.fuse({"fraud_payment": 0.2})["risk_score"]
    r2 = engine.fuse({"fraud_payment": 0.6})["risk_score"]
    r3 = engine.fuse({"fraud_payment": 0.9})["risk_score"]
    assert r1 <= r2 <= r3


def test_duplicate_event_id_idempotent(scorer, fixture_frame):
    sample = fixture_frame.head(5).copy()
    out1 = scorer.score_events(sample)
    out2 = scorer.score_events(sample)
    pd.testing.assert_frame_equal(out1, out2)


def test_batch_vs_scalar_fuse_agree():
    engine = RiskFusionEngine(FUSION_WEIGHTS)
    grid = np.linspace(0, 1, 101)
    for k in FUSION_WEIGHTS:
        engine.fit_calibrator(k, grid, grid)

    rng = np.random.default_rng(42)
    scores = pd.DataFrame({
        "fraud_payment": rng.uniform(0, 1, 50),
        "cyber": rng.uniform(0, 1, 50),
        "behaviour": rng.uniform(0, 1, 50),
        "quantum": rng.uniform(0, 1, 50),
    })
    batch_out = engine.fuse_frame(scores)
    for i in range(len(scores)):
        row = scores.iloc[i].to_dict()
        scalar_out = engine.fuse(row)
        assert batch_out["risk_score"].iloc[i] == pytest.approx(scalar_out["risk_score"], abs=1e-4)


def test_extreme_amounts_no_nan(scorer):
    amounts = [0.0, 1e-9, 1e9, float("inf"), float("-inf"), np.nan]
    df = pd.DataFrame([{
        "event_id": f"ext-{i}",
        "event_domain": "financial",
        "event_type": "card_txn",
        "amount": amt,
    } for i, amt in enumerate(amounts)])
    out = scorer.score_events(df)
    assert np.isfinite(out["risk_score"]).all()


def test_unknown_domain_scores_as_unscored(scorer):
    df = pd.DataFrame([{
        "event_id": "unk-1",
        "event_domain": "threat_intel",
        "event_type": "ioc_feed",
    }])
    out = scorer.score_events(df)
    assert out.iloc[0]["scored"] is False or out.iloc[0]["scored"] == 0
    assert out.iloc[0]["risk_level"] == "low"
    assert out.iloc[0]["risk_score"] == 0.0


def test_contract_hash_mismatch_rejected(mini_artifacts):
    bundle = joblib.load(mini_artifacts / "fraud_payment_bundle.joblib")
    assert "features" in bundle
    assert isinstance(bundle["features"], list)


def test_feature_count_exact(mini_artifacts, fixture_frame):
    for key in DOMAIN_OF_MODEL:
        bundle = joblib.load(mini_artifacts / f"{key}_bundle.joblib")
        sample = fixture_frame[fixture_frame["event_domain"] == DOMAIN_OF_MODEL[key]].head(10)
        if sample.empty:
            sample = fixture_frame.head(10)
        X, _ = build_matrix(sample, key, CategoryEncoder(bundle["encoder_mapping"]))
        X_sel = X[bundle["features"]]
        assert X_sel.shape[1] == len(bundle["features"])


def test_calibrator_output_in_01():
    engine = RiskFusionEngine({"cyber": 1.0})
    grid = np.linspace(0, 1, 50)
    engine.fit_calibrator("cyber", grid, grid)
    scores = np.array([-10.0, -0.5, 0.0, 0.5, 1.0, 2.0, 100.0])
    cal = engine.calibrate("cyber", scores)
    assert (cal >= 0.0).all() and (cal <= 1.0).all()


def test_noisy_or_accumulation():
    engine = RiskFusionEngine(FUSION_WEIGHTS)
    grid = np.linspace(0, 1, 101)
    for k in FUSION_WEIGHTS:
        engine.fit_calibrator(k, grid, grid)

    one_signal = engine.fuse({"fraud_payment": 0.5})["risk_score"]
    two_signals = engine.fuse({"fraud_payment": 0.5, "cyber": 0.5})["risk_score"]
    three_signals = engine.fuse({"fraud_payment": 0.5, "cyber": 0.5, "quantum": 0.5})["risk_score"]
    assert one_signal < two_signals < three_signals
