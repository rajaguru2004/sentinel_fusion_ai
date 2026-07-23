"""Service test fixtures. Uses the tiny mini_artifacts models (fast tier, no real
models/ or big data needed) and the in-memory feature store."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

API_KEY = "test-key"


@pytest.fixture(scope="session")
def client(mini_artifacts):
    import os

    from service.app import create_app
    from service.settings import get_settings

    os.environ["SENTINEL_MODELS_DIR"] = str(mini_artifacts)
    os.environ["SENTINEL_API_KEYS"] = API_KEY
    os.environ["SENTINEL_REQUIRE_AUTH"] = "true"
    os.environ.pop("SENTINEL_REDIS_URL", None)  # -> in-memory store
    get_settings.cache_clear()

    app = create_app()
    with TestClient(app) as c:
        yield c

    get_settings.cache_clear()


@pytest.fixture
def auth():
    return {"X-API-Key": API_KEY}


@pytest.fixture
def sample_events():
    base = "2024-03-01T12:00:00+00:00"
    return {
        "financial": {"event_id": "f1", "event_domain": "financial",
                      "event_time": base, "event_type": "card_txn",
                      "amount": 250.0, "user_id": "alice"},
        "cyber": {"event_id": "c1", "event_domain": "cyber", "event_time": base,
                  "event_type": "network_flow", "device_id": "dev1", "user_id": "bob",
                  "severity": 4, "bytes_in": 100.0, "bytes_out": 9000.0,
                  "dst_port": 4444, "protocol": "tcp"},
        "behaviour": {"event_id": "b1", "event_domain": "behaviour",
                      "event_time": base, "event_type": "login", "user_id": "carol",
                      "device_id": "dev2", "country": "US"},
        "quantum": {"event_id": "q1", "event_domain": "quantum", "event_time": base,
                    "event_type": "tls_handshake", "bytes_out": 5000.0,
                    "q_key_exchange": "rsa", "q_cert_key_type": "rsa2048",
                    "q_data_class": "restricted", "q_cert_age_days": 400.0,
                    "q_cert_validity_days": 825.0},
        "threat_intel": {"event_id": "t1", "event_domain": "threat_intel",
                         "event_time": base, "event_type": "ioc_ip"},
    }
