"""Integration test: POST /investigate contract.

Tests that the endpoint returns a valid AttackReplayResponse schema for
a cyber-domain event, and that all required fields are present and typed.

Uses the mini_artifacts fixture so no network or full trained model needed.
Marked 'integration' to be excluded from fast unit test runs.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from service.replay.attack_kb import STAGES


# ---------------------------------------------------------------------------
# App fixture
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def app(mini_artifacts):
    """Build the FastAPI app against mini trained artifacts."""
    import os
    os.environ["SENTINEL_MODELS_DIR"] = str(mini_artifacts)
    os.environ["SENTINEL_REQUIRE_AUTH"] = "false"
    os.environ["SENTINEL_ENABLE_EXPLAIN"] = "true"
    from service.app import create_app
    return create_app()


@pytest.fixture(scope="module")
def client(app):
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Payload
# ---------------------------------------------------------------------------

CYBER_EVENT = {
    "event_id": "integ-cyber-001",
    "event_domain": "cyber",
    "event_time": "2026-07-26T00:00:00+00:00",
    "user_id": "attacker-99",
    "device_id": "srv-prod-01",
    "bytes_out": 200_000,
    "bytes_in": 12_000,
    "dst_port": 445,
    "protocol": "TCP",
    "severity": 4,
    "duration_s": 7200.0,
}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_investigate_cyber_returns_200(client):
    resp = client.post("/investigate", json=CYBER_EVENT)
    assert resp.status_code == 200, resp.text


def test_investigate_response_schema(client):
    resp = client.post("/investigate", json=CYBER_EVENT)
    data = resp.json()

    # Top-level required fields
    assert isinstance(data["incident_id"], str)
    assert isinstance(data["event_id"], str)
    assert data["domain"] == "cyber"
    assert isinstance(data["risk_score"], float)
    assert data["risk_level"] in ("low", "medium", "high", "critical")
    assert isinstance(data["investigated_at"], str)
    assert isinstance(data["ai_summary"], str)
    assert isinstance(data["investigation_confidence"], float)
    assert 0.0 <= data["investigation_confidence"] <= 1.0


def test_current_stage_is_valid_mitre(client):
    resp = client.post("/investigate", json=CYBER_EVENT)
    data = resp.json()
    stage = data["current_stage"]
    assert stage["stage_id"] in STAGES
    assert isinstance(stage["stage_name"], str)
    assert isinstance(stage["kill_chain_phase"], str)
    assert isinstance(stage["description"], str)


def test_predicted_stages_non_empty(client):
    resp = client.post("/investigate", json=CYBER_EVENT)
    data = resp.json()
    assert len(data["predicted_stages"]) >= 1


def test_predicted_stages_confidence_in_range(client):
    resp = client.post("/investigate", json=CYBER_EVENT)
    data = resp.json()
    for ps in data["predicted_stages"]:
        assert 0.05 <= ps["confidence"] <= 0.95
        assert ps["probability_label"] in ("High", "Medium", "Low")
        assert isinstance(ps["explanation"], str)
        assert ps["stage_id"] in STAGES


def test_replay_timeline_ordered(client):
    resp = client.post("/investigate", json=CYBER_EVENT)
    data = resp.json()
    timeline = data["replay_timeline"]
    assert len(timeline) >= 1
    indices = [step["step_index"] for step in timeline]
    assert indices == list(range(1, len(indices) + 1))


def test_replay_timeline_has_sentinel_intervention(client):
    resp = client.post("/investigate", json=CYBER_EVENT)
    data = resp.json()
    timeline = data["replay_timeline"]
    assert any(step["is_sentinel_intervention"] for step in timeline)


def test_sentinel_response_non_empty_with_mode(client):
    resp = client.post("/investigate?sentinel_mode=true", json=CYBER_EVENT)
    data = resp.json()
    assert len(data["sentinel_response"]) >= 1
    for step in data["sentinel_response"]:
        assert isinstance(step["action"], str)
        assert isinstance(step["outcome"], str)


def test_sentinel_response_empty_without_mode(client):
    resp = client.post("/investigate?sentinel_mode=false", json=CYBER_EVENT)
    data = resp.json()
    assert data["sentinel_response"] == []


def test_score_passthrough_present(client):
    resp = client.post("/investigate", json=CYBER_EVENT)
    data = resp.json()
    score = data["score"]
    assert score["event_id"] == "integ-cyber-001"
    assert isinstance(score["risk_score"], float)
    assert score["risk_level"] in ("low", "medium", "high", "critical")


def test_non_cyber_domain_returns_422(client):
    payload = {**CYBER_EVENT, "event_id": "integ-fin-001", "event_domain": "financial"}
    resp = client.post("/investigate", json=payload)
    assert resp.status_code == 422
    assert "cyber" in resp.json()["detail"].lower()


def test_attack_maturity_is_valid(client):
    resp = client.post("/investigate", json=CYBER_EVENT)
    data = resp.json()
    assert data["attack_maturity"] in ("Early", "Mid", "Late", "Critical")
