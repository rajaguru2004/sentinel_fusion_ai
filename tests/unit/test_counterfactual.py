"""Unit tests for Counterfactual Recommendation Engine components."""
from __future__ import annotations

import pytest

from service.counterfactual import (
    MUTABLE_FEATURE_SPECS,
    RISK_LEVEL_ORDER,
    _update_dependent_engineered_features,
)


def test_risk_level_order():
    assert RISK_LEVEL_ORDER["low"] < RISK_LEVEL_ORDER["medium"]
    assert RISK_LEVEL_ORDER["medium"] < RISK_LEVEL_ORDER["high"]
    assert RISK_LEVEL_ORDER["high"] < RISK_LEVEL_ORDER["critical"]


def test_dependent_feature_updates():
    ev = {
        "event_id": "test1",
        "amount": 1000.0,
        "balance_before": 2000.0,
        "balance_after": 1000.0,
        "bytes_in": 100.0,
        "bytes_out": 900.0,
        "counterparty_is_new": 1,
    }
    updated = _update_dependent_engineered_features(ev)
    assert updated["f_log1p_amount"] > 0
    assert updated["f_balance_drain_ratio"] == pytest.approx(0.5)
    assert updated["f_counterparty_new"] == 1.0
    assert updated["f_bytes_ratio"] == pytest.approx(901.0 / 101.0)


def test_mutable_feature_specs():
    assert "amount" in MUTABLE_FEATURE_SPECS
    assert "counterparty_is_new" in MUTABLE_FEATURE_SPECS
    assert "q_key_exchange" in MUTABLE_FEATURE_SPECS

    # Test amount candidate generation
    amt_spec = MUTABLE_FEATURE_SPECS["amount"]
    cands = amt_spec["generate_candidates"](1000.0, {"amount": 1000.0})
    assert len(cands) > 0
    assert 500.0 in cands

    # Test discrete candidate generation
    cp_spec = MUTABLE_FEATURE_SPECS["counterparty_is_new"]
    cp_cands = cp_spec["generate_candidates"](1, {})
    assert cp_cands == [0]

    # Test quantum candidate generation
    q_spec = MUTABLE_FEATURE_SPECS["q_key_exchange"]
    q_cands = q_spec["generate_candidates"]("RSA", {})
    assert "Kyber768" in q_cands
