"""Integration tests for Threat Graph API endpoints."""
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from service.app import create_app
from service.settings import get_settings


@pytest.fixture
def client():
    app = create_app()
    with TestClient(app) as c:
        yield c


def test_graph_generate_endpoint(client):
    settings = get_settings()
    key = list(settings.api_key_map.values())[0] if settings.api_key_map else "sentinel-demo-key-2026"
    headers = {"X-API-Key": key}
    payload = {
        "event_id": "ev_test_graph_001",
        "event_domain": "financial",
        "event_time": datetime.now(timezone.utc).isoformat(),
        "user_id": "usr_test_100",
        "device_id": "dev_test_200",
        "amount": 15000.0,
        "counterparty_id": "ben_test_300",
        "counterparty_is_new": 1,
        "device_is_new": 1,
    }

    res = client.post("/graph/generate", json=payload, headers=headers)
    assert res.status_code == 200
    data = res.json()

    assert "incident_id" in data
    assert data["domain"] == "financial"
    assert len(data["nodes"]) >= 3
    assert len(data["edges"]) >= 2
    assert "verdict" in data
    assert "animation_steps" in data

    # Test GET by incident_id
    inc_id = data["incident_id"]
    get_res = client.get(f"/graph/incident/{inc_id}", headers=headers)
    assert get_res.status_code == 200
    get_data = get_res.json()
    assert get_data["incident_id"] == inc_id


def test_score_with_include_graph_query_param(client):
    settings = get_settings()
    key = list(settings.api_key_map.values())[0] if settings.api_key_map else "sentinel-demo-key-2026"
    headers = {"X-API-Key": key}
    payload = {
        "event_id": "ev_test_score_graph_002",
        "event_domain": "financial",
        "event_time": datetime.now(timezone.utc).isoformat(),
        "user_id": "usr_test_101",
        "device_id": "dev_test_201",
        "amount": 5000.0,
    }

    res = client.post("/score?include_graph=true&explain=true", json=payload, headers=headers)
    assert res.status_code == 200
    data = res.json()

    assert "threat_graph" in data
    assert data["threat_graph"] is not None
    assert data["threat_graph"]["domain"] == "financial"
    assert len(data["threat_graph"]["nodes"]) >= 2
