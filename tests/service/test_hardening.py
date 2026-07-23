"""Production hardening: per-client keys + rate limiting (§5.1) and the
feature-store circuit breaker (§5.2)."""
from __future__ import annotations

import asyncio

import pytest

from service.auth import RateLimiter
from service.feature_service import FeatureService
from service.settings import Settings


# ------------------------------------------------------------- named keys ----
def test_named_keys_are_parsed():
    s = Settings(api_keys="core-banking:abc123,fraud-ops:def456")
    assert s.api_key_map == {"core-banking": "abc123", "fraud-ops": "def456"}


def test_unnamed_keys_get_positional_names():
    """Legacy `k1,k2` config must keep working."""
    s = Settings(api_keys="k1,k2")
    assert s.api_key_map == {"client-1": "k1", "client-2": "k2"}
    assert s.api_key_set == frozenset({"k1", "k2"})


def test_key_may_contain_a_colon():
    """Only the first ':' separates name from key — a base64/hex key can contain one."""
    s = Settings(api_keys="ops:abc:def")
    assert s.api_key_map == {"ops": "abc:def"}


# ----------------------------------------------------------- rate limiter ----
def test_rate_limit_is_per_client_not_global():
    """One noisy integration must not throttle the others — the whole reason
    keys are named."""
    rl = RateLimiter(per_minute=2)
    assert rl.allow("a", now=0.0)[0]
    assert rl.allow("a", now=0.1)[0]
    assert not rl.allow("a", now=0.2)[0]      # 'a' exhausted
    assert rl.allow("b", now=0.2)[0]          # 'b' unaffected


def test_rate_limit_window_slides():
    rl = RateLimiter(per_minute=2)
    rl.allow("a", now=0.0)
    rl.allow("a", now=1.0)
    assert not rl.allow("a", now=2.0)[0]
    allowed, _ = rl.allow("a", now=61.0)      # first hit has aged out
    assert allowed


def test_rate_limit_reports_retry_after():
    rl = RateLimiter(per_minute=1)
    rl.allow("a", now=0.0)
    allowed, retry_after = rl.allow("a", now=10.0)
    assert not allowed and 1 <= retry_after <= 61


def test_zero_disables_rate_limiting():
    rl = RateLimiter(per_minute=0)
    assert all(rl.allow("a", now=float(i))[0] for i in range(100))


# -------------------------------------------------------- circuit breaker ----
class _DeadStore:
    """Store that always fails, and counts how often it was actually called."""

    def __init__(self) -> None:
        self.calls = 0

    async def snapshot_and_advance(self, ev):
        self.calls += 1
        raise ConnectionError("store down")

    async def peek(self, ev):
        return await self.snapshot_and_advance(ev)


def _event(i: int) -> dict:
    import pandas as pd
    return {"event_id": f"e{i}", "user_id": "u", "amount": 10.0,
            "event_time": pd.Timestamp("2026-06-01T00:00:00Z")}


def test_breaker_opens_and_stops_calling_a_dead_store():
    """A dead store must not cost every request the full timeout — that is how
    a slow dependency turns into a breached latency SLA on the money path."""
    store = _DeadStore()
    fs = FeatureService(store, timeout_ms=50, breaker_fail_threshold=3,
                        breaker_reset_s=60.0)

    async def run():
        for i in range(10):
            feats, detail = await fs.build(_event(i))
            assert detail.store_unavailable is True   # always degrades cleanly
            assert feats                              # stateless features still present
    asyncio.run(run())

    assert store.calls == 3, f"breaker did not open; store called {store.calls}x"
    assert fs.breaker_state == "open"


def test_breaker_half_opens_after_reset_window():
    store = _DeadStore()
    fs = FeatureService(store, timeout_ms=50, breaker_fail_threshold=2,
                        breaker_reset_s=0.05)

    async def run():
        for i in range(5):
            await fs.build(_event(i))
        assert fs.breaker_state == "open"
        await asyncio.sleep(0.06)
        assert fs.breaker_state != "open"       # probe allowed through
        await fs.build(_event(99))
    asyncio.run(run())
    assert store.calls > 2, "breaker never retried the store"


def test_healthy_store_keeps_breaker_closed():
    from service.store import InMemoryStore
    fs = FeatureService(InMemoryStore(), timeout_ms=500)

    async def run():
        for i in range(5):
            _, detail = await fs.build(_event(i))
            assert detail.store_unavailable is False
    asyncio.run(run())
    assert fs.breaker_state == "closed"


@pytest.mark.parametrize("threshold", [1, 5])
def test_breaker_threshold_is_respected(threshold):
    store = _DeadStore()
    fs = FeatureService(store, timeout_ms=50, breaker_fail_threshold=threshold,
                        breaker_reset_s=60.0)

    async def run():
        for i in range(threshold + 5):
            await fs.build(_event(i))
    asyncio.run(run())
    assert store.calls == threshold


# ------------------------------------------------------ end-to-end (HTTP) ----
def test_rate_limit_returns_429_with_retry_after(mini_artifacts, monkeypatch):
    """Through the real HTTP stack, not just the limiter unit."""
    import os

    from fastapi.testclient import TestClient

    from service import auth
    from service.app import create_app
    from service.settings import get_settings

    monkeypatch.setenv("SENTINEL_MODELS_DIR", str(mini_artifacts))
    monkeypatch.setenv("SENTINEL_API_KEYS", "core:key-a,ops:key-b")
    monkeypatch.setenv("SENTINEL_REQUIRE_AUTH", "true")
    monkeypatch.setenv("SENTINEL_RATE_LIMIT_PER_MINUTE", "3")
    os.environ.pop("SENTINEL_REDIS_URL", None)
    get_settings.cache_clear()
    auth.reset_limiter()
    try:
        with TestClient(create_app()) as c:
            body = {"event_id": "rl", "event_domain": "financial",
                    "event_time": "2026-06-01T00:00:00Z", "amount": 10.0}
            codes = [c.post("/score", json={**body, "event_id": f"rl{i}"},
                            headers={"X-API-Key": "key-a"}).status_code
                     for i in range(5)]
            assert codes[:3] == [200, 200, 200], codes
            assert codes[3] == 429, codes
            limited = c.post("/score", json=body, headers={"X-API-Key": "key-a"})
            assert "Retry-After" in limited.headers

            # the OTHER client is unaffected — per-client, not global
            other = c.post("/score", json={**body, "event_id": "rl-b"},
                           headers={"X-API-Key": "key-b"})
            assert other.status_code == 200
    finally:
        get_settings.cache_clear()
        auth.reset_limiter()


def test_ready_exposes_breaker_state(client):
    assert client.get("/ready").json()["store_breaker"] == "closed"
