"""Test FastAPI streaming stress test endpoint."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from service.app import create_app

KEY = "sentinel-demo-key-2026"
H = {"X-API-Key": KEY}


@pytest.fixture
def client(mini_artifacts, monkeypatch):
    from service.scorer_service import ScorerService
    app = create_app()
    app.state.scorer = ScorerService(mini_artifacts)
    app.state.scorer.scorer.models_dir = mini_artifacts
    with TestClient(app) as c:
        yield c



def test_stress_test_stream_endpoint(client):
    response = client.get("/stress-test/stream", headers=H)
    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]
    assert "data: " in response.text
    assert '"type": "log"' in response.text
    assert '"type": "done"' in response.text
