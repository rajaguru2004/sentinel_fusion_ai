"""End-to-end production readiness against the REAL deployed stack.

Runs against `docker compose up` (API container + Redis), not TestClient — so it
exercises the actual image, the real Redis Lua scripts, uvicorn workers and the
network hop. Everything else in the suite runs in-process with an in-memory
store; this is the only place the shipped artifact is validated.

    docker compose up -d
    pytest tests/e2e -m e2e

Skipped automatically when the stack is not reachable, so the default tier stays
fast and hermetic.
"""
from __future__ import annotations

import datetime as dt
import os
import uuid

import pytest

try:
    import httpx
except ImportError:                                    # pragma: no cover
    httpx = None

pytestmark = pytest.mark.e2e

BASE = os.environ.get("SENTINEL_E2E_URL", "http://localhost:8000")
KEY = os.environ.get("SENTINEL_E2E_KEY", "sentinel-demo-key-2026")
H = {"X-API-Key": KEY, "Content-Type": "application/json"}


def _iso(t: dt.datetime) -> str:
    return t.isoformat().replace("+00:00", "Z")


@pytest.fixture(scope="module")
def http():
    if httpx is None:
        pytest.skip("httpx not installed")
    try:
        c = httpx.Client(base_url=BASE, timeout=10.0)
        if c.get("/health").status_code != 200:
            pytest.skip(f"stack not healthy at {BASE}")
    except Exception:
        pytest.skip(f"stack not reachable at {BASE} — run `docker compose up -d`")
    yield c
    c.close()


@pytest.fixture(scope="module")
def customer() -> str:
    """Fresh id per run so Redis state from a previous run cannot leak in."""
    return f"e2e-{uuid.uuid4().hex[:10]}"


# Unique per test-run. event_id is the idempotency key and Redis keeps claims
# for the state TTL, so a fixed id makes every rerun a no-op REPLAY that never
# advances state — the suite would pass once and then fail forever after.
RUN = uuid.uuid4().hex[:8]


def _pay(eid, t, customer, **kw):
    body = {"event_id": f"{RUN}-{eid}", "event_domain": "financial", "event_type": "card_txn",
            "event_time": _iso(t), "user_id": customer, "country": "GB",
            "channel": "pos", "currency": "GBP", "is_credit": 0,
            "merchant_category": "grocery_pos", "counterparty_id": "mrc-1",
            "amount": 50.0, "customer_age": 41.0}
    body.update(kw)
    return body


# ------------------------------------------------------------------ ops ------
def test_health(http):
    assert http.get("/health").json() == {"status": "ok"}


def test_ready_reports_contract_and_breaker(http):
    body = http.get("/ready").json()
    assert body["ready"] is True
    assert body["scorer_loaded"] is True
    assert body["store_ok"] is True, "Redis not reachable from the container"
    assert len(body["contract_hash"]) == 16
    assert body["store_breaker"] == "closed"


def test_metrics_exposes_the_documented_series(http):
    text = http.get("/metrics").text
    for series in ("sentinel_score_latency_seconds", "sentinel_scored_total",
                   "sentinel_degraded_total", "sentinel_cold_entity_total",
                   "sentinel_risk_score", "sentinel_store_breaker_open"):
        assert series in text, f"{series} missing from /metrics"


def test_openapi_is_served(http):
    paths = http.get("/openapi.json").json()["paths"]
    for p in ("/score", "/score/batch", "/ingest", "/ingest/batch",
              "/feedback", "/feedback/batch"):
        assert p in paths


# ----------------------------------------------------------------- auth ------
def test_unauthenticated_is_rejected(http):
    r = http.post("/score", json=_pay("noauth", dt.datetime.now(dt.timezone.utc),
                                      "x"), headers={})
    assert r.status_code == 401


def test_ops_endpoints_need_no_key(http):
    assert http.get("/health", headers={}).status_code == 200
    assert http.get("/metrics", headers={}).status_code == 200


# ------------------------------------------------ the full banking flow ------
def test_full_banking_flow_through_real_redis(http, customer):
    """Cold -> ingest -> warm -> replay -> fraud, end to end.

    This is the integration the bank actually performs, run against the shipped
    image and a real Redis rather than an in-process fake.
    """
    t = dt.datetime(2026, 5, 1, 9, 0, tzinfo=dt.timezone.utc)

    # 1. cold: no history for this customer yet
    cold = http.post("/score", json=_pay("c0", t, customer), headers=H).json()
    assert cold["model"] == "fraud_payment"
    assert cold["degradation"]["user_history"] is True
    assert cold["degradation"]["store_unavailable"] is False

    # 2. stream context events -- no scoring
    events = []
    for i in range(12):
        t += dt.timedelta(minutes=20)
        events.append(_pay(f"ctx{i}", t, customer, event_type="balance_check"))
    r = http.post("/ingest/batch", json={"events": events}, headers=H)
    assert r.status_code == 202
    assert r.json() == {"accepted": 12, "rejected": 0}

    # 3. warm: history now exists and survived the Redis round trip
    t += dt.timedelta(minutes=30)
    warm = http.post("/score", json=_pay("w0", t, customer), headers=H).json()
    assert warm["degradation"]["user_history"] is False
    assert warm["degradation"]["degraded"] is False

    # 4. build a spend profile
    for i in range(40):
        t += dt.timedelta(hours=5)
        http.post("/score", json=_pay(f"n{i}", t, customer, amount=48.0 + (i % 6),
                                      counterparty_id=f"mrc-{i % 3}"), headers=H)

    # 5. normal purchase -> low
    t += dt.timedelta(hours=5)
    ok = http.post("/score", json=_pay("ok", t, customer, amount=52.0),
                   headers=H).json()
    assert ok["risk_level"] == "low", ok["risk_score"]

    # 6. fraud-shaped payment -> escalates, with analyst-readable reasons
    t += dt.timedelta(minutes=20)
    bad = http.post("/score?explain=true",
                    json=_pay("bad", t, customer, amount=9000.0,
                              counterparty_id="brand-new", name_mismatch=1,
                              counterparty_age_s=300, bank_txn_count_1h=8,
                              merchant_category="shopping_net"),
                    headers=H).json()
    assert bad["risk_level"] in ("high", "critical"), bad
    assert bad["risk_score"] > ok["risk_score"] * 100
    assert bad["explanation"]["model"] == "fraud_payment"
    assert bad["explanation"]["reasons"], "no plain-language reasons returned"
    # benign traffic must not get invented narrative
    assert ok.get("explanation") is None


def test_score_is_idempotent_across_the_network(http, customer):
    """§3.2 through the real stack: a retry must not double-advance Redis, and
    must return byte-identical features.

    Regression: the Redis replay path used to RECONSTRUCT the pre-event state
    from post-advance counters. It got `seq` right but returned the *current*
    amount moments, so once a customer had spend history the replayed
    `f_amount_z_user` / `f_amount_ratio_mean` differed and the risk score moved
    — silently breaking the guarantee the API reference makes. The winner now
    stores the exact snapshot it returned.
    """
    t = dt.datetime(2026, 6, 1, 9, 0, tzinfo=dt.timezone.utc)
    # give the customer real amount history first — with an empty history the
    # moments are NaN on both paths and the bug cannot show.
    for i in range(6):
        http.post("/score", json=_pay(f"warm-{uuid.uuid4().hex[:6]}",
                                      t + dt.timedelta(minutes=i), customer,
                                      amount=40.0 + i * 7), headers=H)
    eid = f"idem-{uuid.uuid4().hex[:8]}"
    ev = _pay(eid, t + dt.timedelta(hours=1), customer, amount=830.0)
    first = http.post("/score", json=ev, headers=H).json()
    replay = http.post("/score", json=ev, headers=H).json()
    assert replay["risk_score"] == first["risk_score"], (
        f"replay diverged: {first['risk_score']} vs {replay['risk_score']}")
    assert replay["raw_score"] == first["raw_score"]


def test_bank_context_lifts_a_cold_store_score(http):
    """§3.3 acceptance: the bank's own signals must reach the model."""
    fresh = f"e2e-cold-{uuid.uuid4().hex[:8]}"
    t = dt.datetime(2026, 6, 2, 3, 0, tzinfo=dt.timezone.utc)
    plain = http.post("/score", json=_pay("p1", t, fresh, amount=7000.0),
                      headers=H).json()
    rich = http.post("/score", json=_pay("p2", t, f"{fresh}-b", amount=7000.0,
                                         name_mismatch=1, counterparty_is_new=1,
                                         counterparty_age_s=180,
                                         bank_txn_count_1h=9,
                                         bank_is_new_beneficiary=1),
                     headers=H).json()
    assert rich["degradation"]["bank_context_used"] is True
    assert rich["risk_score"] >= plain["risk_score"]


def test_routing_is_correct_per_domain(http):
    t = dt.datetime(2026, 6, 3, 9, 0, tzinfo=dt.timezone.utc)
    cases = [
        ({"event_domain": "financial", "event_type": "card_txn"}, "fraud_payment"),
        ({"event_domain": "financial", "event_type": "account_open"},
         "fraud_application"),
        ({"event_domain": "cyber", "event_type": "network_flow"}, "cyber"),
        ({"event_domain": "behaviour", "event_type": "login"}, "behaviour"),
        ({"event_domain": "quantum", "event_type": "tls_handshake"}, "quantum"),
    ]
    for extra, expected in cases:
        body = {"event_id": f"route-{expected}-{uuid.uuid4().hex[:6]}",
                "event_time": _iso(t), "amount": 100.0, **extra}
        got = http.post("/score", json=body, headers=H).json()
        assert got["model"] == expected, (extra, got["model"])


def test_threat_intel_is_unscored_not_an_error(http):
    t = dt.datetime(2026, 6, 3, 9, 0, tzinfo=dt.timezone.utc)
    r = http.post("/score", json={"event_id": f"ti-{uuid.uuid4().hex[:6]}",
                                  "event_domain": "threat_intel",
                                  "event_time": _iso(t)}, headers=H)
    assert r.status_code == 200
    assert r.json()["scored"] is False
    assert r.json()["risk_level"] == "low"


def test_batch_preserves_request_order(http, customer):
    t = dt.datetime(2026, 6, 4, 9, 0, tzinfo=dt.timezone.utc)
    ids = [f"bo-{uuid.uuid4().hex[:6]}-{i}" for i in range(5)]
    events = [_pay(e, t + dt.timedelta(minutes=i), customer)
              for i, e in enumerate(ids)]
    sent = [e["event_id"] for e in events]
    out = http.post("/score/batch", json={"events": events}, headers=H).json()
    assert [r["event_id"] for r in out["results"]] == sent


def test_feedback_round_trip(http, customer):
    eid = f"fb-{uuid.uuid4().hex[:8]}"
    first = http.post("/feedback",
                      json={"event_id": eid, "user_id": customer, "label": 1},
                      headers=H).json()
    dup = http.post("/feedback",
                    json={"event_id": eid, "user_id": customer, "label": 1},
                    headers=H).json()
    assert first["applied"] is True and dup["applied"] is False


# ------------------------------------------------------------ validation ----
def test_rejects_unknown_field(http, customer):
    t = dt.datetime(2026, 6, 5, 9, 0, tzinfo=dt.timezone.utc)
    body = {**_pay("bad-field", t, customer), "not_a_field": 1}
    assert http.post("/score", json=body, headers=H).status_code == 422


def test_rejects_naive_timestamp(http, customer):
    body = _pay("naive", dt.datetime(2026, 6, 5, 9, 0, tzinfo=dt.timezone.utc),
                customer)
    body["event_time"] = "2026-06-05T09:00:00"
    assert http.post("/score", json=body, headers=H).status_code == 422


def test_rejects_future_event(http, customer):
    future = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=2)
    assert http.post("/score", json=_pay("future", future, customer),
                     headers=H).status_code == 422


def test_batch_size_cap(http, customer):
    t = dt.datetime(2026, 6, 6, 9, 0, tzinfo=dt.timezone.utc)
    events = [_pay(f"big{i}", t, customer) for i in range(1001)]
    assert http.post("/score/batch", json={"events": events},
                     headers=H).status_code == 413


# --------------------------------------------------------------- latency ----
def test_latency_fits_the_bank_budget(http, customer):
    """The bank's client budget is ~800 ms end to end, including its own hops."""
    import statistics
    import time
    t = dt.datetime(2026, 6, 7, 9, 0, tzinfo=dt.timezone.utc)
    http.post("/score", json=_pay("warmup", t, customer), headers=H)   # warm
    lat = []
    for i in range(30):
        body = _pay(f"lat{i}", t + dt.timedelta(minutes=i), customer)
        t0 = time.perf_counter()
        r = http.post("/score", json=body, headers=H)
        lat.append((time.perf_counter() - t0) * 1e3)
        assert r.status_code == 200
    p50, p95 = statistics.median(lat), sorted(lat)[int(len(lat) * 0.95)]
    print(f"\n  /score over HTTP+Redis: p50={p50:.1f}ms p95={p95:.1f}ms")
    assert p95 < 200, f"p95 {p95:.1f}ms too slow for an 800ms client budget"


def test_ingest_is_cheaper_than_score(http, customer):
    import statistics
    import time
    t = dt.datetime(2026, 6, 8, 9, 0, tzinfo=dt.timezone.utc)

    def timed(path, prefix):
        out = []
        for i in range(20):
            body = _pay(f"{prefix}{i}", t + dt.timedelta(minutes=i), customer,
                        event_type="balance_check")
            t0 = time.perf_counter()
            http.post(path, json=body, headers=H)
            out.append((time.perf_counter() - t0) * 1e3)
        return statistics.median(out)

    ing, sc = timed("/ingest", "pi"), timed("/score", "ps")
    print(f"\n  /ingest p50={ing:.1f}ms vs /score p50={sc:.1f}ms")
    assert ing < sc, f"/ingest ({ing:.1f}ms) not cheaper than /score ({sc:.1f}ms)"


def test_state_survives_across_requests(http):
    """Redis-backed state must be shared across uvicorn workers.

    The in-memory store is per-process, so with --workers 2 a customer's history
    would appear and disappear depending on which worker answered. This passing
    is what proves the deployment is actually using Redis.
    """
    run = RUN
    cust = f"e2e-persist-{uuid.uuid4().hex[:8]}"
    t = dt.datetime(2026, 6, 9, 9, 0, tzinfo=dt.timezone.utc)
    # event_ids must be unique PER RUN as well as per event: they are the
    # idempotency key, and Redis keeps claims for the state TTL, so reusing a
    # fixed id makes a rerun a no-op replay rather than a fresh advance.
    for i in range(15):
        http.post("/ingest", json=_pay(f"ps-{run}-{i}", t + dt.timedelta(minutes=i),
                                       cust, event_type="balance_check"),
                  headers=H)
    # hammer it: whichever worker answers must see the same history
    for i in range(10):
        r = http.post("/score", json=_pay(f"pc-{run}-{i}",
                                          t + dt.timedelta(hours=1, minutes=i),
                                          cust), headers=H).json()
        assert r["degradation"]["user_history"] is False, (
            "history vanished between requests — workers are not sharing Redis")
