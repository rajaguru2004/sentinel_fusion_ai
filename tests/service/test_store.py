"""Feature-store backends: in-memory and Redis (fakeredis) must behave identically
on the read->compute->write contract."""
from __future__ import annotations

import itertools

import pandas as pd
import pytest

from service.store import InMemoryStore, RedisFeatureStore

_SEQ = itertools.count()


def _ev(**kw):
    """Distinct event_id per call.

    Reusing one id would now hit the §3.2 idempotency guard and return the
    cached snapshot instead of advancing state — correct behaviour, but not what
    these tests are exercising. Replay is covered explicitly by
    test_score_is_idempotent_per_event_id.
    """
    base = {"event_id": f"e{next(_SEQ)}", "event_domain": "cyber",
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
    ust, ctx, _ = await store.snapshot_and_advance(
        _ev(user_id="u", event_time=t0, amount=100.0, country="US"))
    assert ust.seq == 0 and ust.last_ts is None and ctx.seen_country is False

    t1 = t0 + pd.Timedelta(seconds=60)
    ust, ctx, _ = await store.snapshot_and_advance(
        _ev(user_id="u", event_time=t1, amount=300.0, country="US"))
    assert ust.seq == 1
    assert ust.last_ts == pytest.approx(t0.timestamp())
    assert ctx.seen_country is True            # US seen before
    assert ust.amt_n == 1 and ust.amt_sum == pytest.approx(100.0)


@pytest.mark.asyncio
async def test_new_country_flag(store):
    await store.snapshot_and_advance(_ev(user_id="u", country="US"))
    _, ctx_gb, _ = await store.snapshot_and_advance(_ev(user_id="u", country="GB"))
    assert ctx_gb.seen_country is False                    # GB is new for this user


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
    ust, ctx, dst = await store.snapshot_and_advance(_ev())
    assert ust is None and dst is None and ctx.seen_country is False


# ---------------------------------------------------------------- schema v2 ---
def _bank_ev(i, minutes, **kw):
    import pandas as pd
    base = pd.Timestamp("2026-06-01T00:00:00Z")
    return dict(event_id=f"e{i}", user_id="u1",
                event_time=base + pd.Timedelta(minutes=minutes),
                amount=100.0, country="GB",
                counterparty_id=kw.pop("cp", "cp0"),
                merchant_category=kw.pop("mcc", "grocery"), **kw)


async def test_counterparty_and_mcc_sets(store):
    for i in range(4):
        await store.snapshot_and_advance(_bank_ev(i, 10 * i, cp=f"cp{i % 2}"))
    _, ctx, _ = await store.snapshot_and_advance(_bank_ev(9, 45, cp="cp0"))
    assert ctx.n_counterparties == 2       # cp0, cp1 seen before this event
    assert ctx.seen_counterparty is True
    assert ctx.seen_merchant_category is True


async def test_velocity_window_expires(store):
    for i in range(4):
        await store.snapshot_and_advance(_bank_ev(i, 10 * i))
    _, ctx, _ = await store.snapshot_and_advance(_bank_ev(9, 45))
    assert ctx.txn_count_window == 4
    _, ctx_far, _ = await store.snapshot_and_advance(_bank_ev(10, 180))
    assert ctx_far.txn_count_window == 0   # 3h gap -> nothing left in the hour


async def test_score_is_idempotent_per_event_id(store):
    """§3.2: a retried event_id must not double-advance any counter."""
    for i in range(3):
        await store.snapshot_and_advance(_bank_ev(i, 10 * i))
    ust, _, _ = await store.snapshot_and_advance(_bank_ev(9, 45))
    replay, _, _ = await store.snapshot_and_advance(_bank_ev(9, 45))
    assert replay.seq == ust.seq, "replay advanced the sequence counter"
    nxt, _, _ = await store.snapshot_and_advance(_bank_ev(20, 50))
    assert nxt.seq == ust.seq + 1, "counter advanced more than once"
