"""Feature-store backends: in-memory and Redis (fakeredis) must behave identically
on the read->compute->write contract."""
from __future__ import annotations

import pandas as pd
import pytest

from service.store import InMemoryStore, RedisFeatureStore


def _ev(**kw):
    base = {"event_id": "e", "event_domain": "cyber",
            "event_time": pd.Timestamp("2024-01-01T00:00:00Z")}
    return {**base, **kw}


async def _redis_store():
    import fakeredis.aioredis
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    return RedisFeatureStore(client, ttl=3600)


@pytest.fixture(params=["mem", "redis"])
async def store(request):
    if request.param == "mem":
        s = InMemoryStore()
    else:
        s = await _redis_store()
    yield s
    await s.close()


@pytest.mark.asyncio
async def test_ping(store):
    assert await store.ping() is True


@pytest.mark.asyncio
async def test_user_sequence_and_recency(store):
    t0 = pd.Timestamp("2024-01-01T00:00:00Z")
    ust, seen, _ = await store.snapshot_and_advance(
        _ev(user_id="u", event_time=t0, amount=100.0, country="US"))
    assert ust.seq == 0 and ust.last_ts is None and seen is False

    t1 = t0 + pd.Timedelta(seconds=60)
    ust, seen, _ = await store.snapshot_and_advance(
        _ev(user_id="u", event_time=t1, amount=300.0, country="US"))
    assert ust.seq == 1
    assert ust.last_ts == pytest.approx(t0.timestamp())
    assert seen is True                       # US seen before
    assert ust.amt_n == 1 and ust.amt_sum == pytest.approx(100.0)


@pytest.mark.asyncio
async def test_new_country_flag(store):
    await store.snapshot_and_advance(_ev(user_id="u", country="US"))
    _, seen_gb, _ = await store.snapshot_and_advance(_ev(user_id="u", country="GB"))
    assert seen_gb is False                    # GB is new for this user


@pytest.mark.asyncio
async def test_device_hisev(store):
    _, _, d0 = await store.snapshot_and_advance(_ev(device_id="d", severity=4))
    assert d0.seq == 0 and d0.hisev == 0
    _, _, d1 = await store.snapshot_and_advance(_ev(device_id="d", severity=1))
    assert d1.seq == 1 and d1.hisev == 1       # prior event was high-severity


@pytest.mark.asyncio
async def test_feedback_increments_pos_idempotently(store):
    await store.snapshot_and_advance(_ev(user_id="u", amount=10.0))
    assert await store.feedback("u", "e1", 1) is True
    assert await store.feedback("u", "e1", 1) is False   # duplicate
    ust, _, _ = await store.snapshot_and_advance(_ev(user_id="u", amount=20.0))
    assert ust.pos == 1


@pytest.mark.asyncio
async def test_no_entity_ids_returns_none(store):
    ust, seen, dst = await store.snapshot_and_advance(_ev())
    assert ust is None and dst is None and seen is False
