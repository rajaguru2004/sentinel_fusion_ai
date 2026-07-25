"""API integration tests for Counterfactual Analysis endpoints."""
from __future__ import annotations

import pytest


def test_score_counterfactual_endpoint_financial(client, auth, sample_events):
    ev = dict(sample_events["financial"])
    ev["amount"] = 50000.0  # High amount to increase risk
    ev["counterparty_is_new"] = 1
    ev["balance_before"] = 55000.0

    payload = {
        "event": ev,
        "target_risk_level": "low",
        "max_recommendations": 3,
    }
    resp = client.post("/score/counterfactual", json=payload, headers=auth)
    assert resp.status_code == 200
    data = resp.json()
    assert data["event_id"] == ev["event_id"]
    assert "original_risk_score" in data
    assert "original_risk_level" in data
    assert data["target_risk_level"] == "low"
    assert isinstance(data["counterfactuals"], list)


def test_score_counterfactual_endpoint_quantum(client, auth, sample_events):
    ev = dict(sample_events["quantum"])
    payload = {
        "event": ev,
        "target_risk_level": "low",
        "max_recommendations": 2,
    }
    resp = client.post("/score/counterfactual", json=payload, headers=auth)
    assert resp.status_code == 200
    data = resp.json()
    assert data["event_id"] == ev["event_id"]
    assert data["model"] == "quantum"


def test_unified_score_with_counterfactual_param(client, auth, sample_events):
    ev = dict(sample_events["financial"])
    ev["amount"] = 25000.0
    ev["counterparty_is_new"] = 1

    resp = client.post("/score?counterfactual=true", json=ev, headers=auth)
    assert resp.status_code == 200
    data = resp.json()
    assert "counterfactuals" in data
    assert data["counterfactuals"] is not None
    assert isinstance(data["counterfactuals"], list)
