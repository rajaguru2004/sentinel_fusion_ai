"""End-to-end ML pipeline & model interaction tests.
Uses mini_artifacts fixture to verify full offline pipeline round-trip hermetically.
"""
from __future__ import annotations

import json
import joblib
import pandas as pd
import pytest

from ml import data as D
from ml.config import CONTRACT_HASH, DOMAIN_OF_MODEL
from ml.predict import SentinelScorer


def test_pipeline_produces_all_bundles(mini_artifacts):
    for key in DOMAIN_OF_MODEL:
        p = mini_artifacts / f"{key}_bundle.joblib"
        assert p.exists(), f"Missing bundle: {p}"
    assert (mini_artifacts / "fusion_engine.joblib").exists()


def test_all_bundles_pass_contract_check(mini_artifacts):
    for key in DOMAIN_OF_MODEL:
        bundle = joblib.load(mini_artifacts / f"{key}_bundle.joblib")
        assert "features" in bundle
        assert "encoder_mapping" in bundle
        assert "threshold" in bundle


def test_scorer_routes_all_domains(mini_artifacts, fixture_frame):
    scorer = SentinelScorer(mini_artifacts)
    sample = (fixture_frame.groupby("event_domain", observed=True)
              .head(2).reset_index(drop=True))
    out = scorer.score_events(sample)
    models_fired = set(out["model"].dropna().unique())
    assert len(models_fired) >= 4, f"Only models fired: {models_fired}"


def test_fused_risk_monotone_with_label(mini_artifacts, fixture_frame, fixture_split):
    scorer = SentinelScorer(mini_artifacts)
    test_slice = fixture_frame[(fixture_split == "test") & (fixture_frame["label"] >= 0)]
    out = scorer.score_events(test_slice)

    pos_mask = test_slice["label"] == 1
    neg_mask = test_slice["label"] == 0

    if pos_mask.sum() > 0 and neg_mask.sum() > 0:
        mean_pos_risk = out.loc[pos_mask, "risk_score"].mean()
        mean_neg_risk = out.loc[neg_mask, "risk_score"].mean()
        assert mean_pos_risk > mean_neg_risk, f"Pos risk {mean_pos_risk:.4f} <= Neg risk {mean_neg_risk:.4f}"


def test_threshold_sane(mini_artifacts):
    for key in DOMAIN_OF_MODEL:
        bundle = joblib.load(mini_artifacts / f"{key}_bundle.joblib")
        t = bundle["threshold"]
        assert 0.0 < t < 1.0, f"{key} threshold {t} invalid"


def test_fusion_band_distribution_non_degenerate(mini_artifacts, fixture_frame):
    scorer = SentinelScorer(mini_artifacts)
    out = scorer.score_events(fixture_frame)
    levels = out["risk_level"].value_counts().to_dict()
    assert len(levels) > 1, f"Bands degenerate: {levels}"


def test_behaviour_model_bundle_exists(mini_artifacts):
    bundle = joblib.load(mini_artifacts / "behaviour_bundle.joblib")
    assert bundle["model"] is not None


def test_calibration_mean_close_to_base_rate(mini_artifacts, fixture_frame, fixture_split):
    scorer = SentinelScorer(mini_artifacts)
    test_slice = fixture_frame[(fixture_split == "test") & (fixture_frame["label"] >= 0)]
    if not test_slice.empty:
        out = scorer.score_events(test_slice)
        calibrated_risk = out["risk_score"].mean()
        actual_label_rate = (test_slice["label"] == 1).mean()
        assert abs(calibrated_risk - actual_label_rate) < 0.25
