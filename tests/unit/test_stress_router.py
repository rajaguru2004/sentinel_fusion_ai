"""Test FastAPI streaming stress test endpoint."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from service.app import create_app

from service.settings import get_settings


@pytest.fixture
def client(mini_artifacts, monkeypatch):
    from service.scorer_service import ScorerService
    app = create_app()
    app.state.scorer = ScorerService(mini_artifacts)
    app.state.scorer.scorer.models_dir = mini_artifacts
    with TestClient(app) as c:
        yield c


def test_stress_test_stream_endpoint(client):
    settings = get_settings()
    key = list(settings.api_key_map.values())[0] if settings.api_key_map else "sentinel-demo-key-2026"
    headers = {"X-API-Key": key}
    response = client.get("/stress-test/stream", headers=headers)
    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]
    assert "data: " in response.text
    assert '"type": "log"' in response.text
    assert '"type": "done"' in response.text
