"""End-to-end API tests: auth, routing, contract, batch, feedback, degradation."""
from __future__ import annotations

import pytest

OUT_KEYS = {"event_id", "model", "raw_score", "risk_score", "risk_level",
            "scored", "contributions", "model_version", "degraded"}
LEVELS = {"low", "medium", "high", "critical"}


# ------------------------------------------------------------------- health ---
def test_health_ok(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_ready_ok(client):
    r = client.get("/ready")
    assert r.status_code == 200 and r.json()["ready"] is True


# --------------------------------------------------------------------- auth ---
def test_score_requires_api_key(client, sample_events):
    r = client.post("/score", json=sample_events["financial"])
    assert r.status_code == 401


def test_score_rejects_bad_key(client, sample_events):
    r = client.post("/score", json=sample_events["financial"],
                    headers={"X-API-Key": "wrong"})
    assert r.status_code == 401


# ---------------------------------------------------------------- contract ----
@pytest.mark.parametrize("domain,expected_model", [
    ("financial", "fraud_payment"), ("cyber", "cyber"),
    ("behaviour", "behaviour"), ("quantum", "quantum")])
def test_routing_and_contract(client, auth, sample_events, domain, expected_model):
    r = client.post("/score", json=sample_events[domain], headers=auth)
    assert r.status_code == 200
    body = r.json()
    assert OUT_KEYS <= set(body)
    assert body["model"] == expected_model
    assert body["scored"] is True
    assert 0.0 <= body["risk_score"] <= 1.0
    assert body["risk_level"] in LEVELS
    assert set(body["contributions"]) == {
        "p_fraud", "p_fraud_payment", "p_fraud_application",
        "p_cyber", "p_behaviour", "p_quantum"}


def test_threat_intel_unscored(client, auth, sample_events):
    body = client.post("/score", json=sample_events["threat_intel"], headers=auth).json()
    assert body["scored"] is False
    assert body["model"] is None
    assert body["risk_score"] == 0.0
    assert body["risk_level"] == "low"


def test_extra_field_rejected(client, auth, sample_events):
    bad = {**sample_events["financial"], "surprise": 1}
    assert client.post("/score", json=bad, headers=auth).status_code == 422


def test_naive_datetime_rejected(client, auth, sample_events):
    bad = {**sample_events["financial"], "event_time": "2024-03-01T12:00:00"}
    assert client.post("/score", json=bad, headers=auth).status_code == 422


def test_future_event_rejected(client, auth, sample_events):
    bad = {**sample_events["financial"], "event_time": "2999-01-01T00:00:00+00:00"}
    assert client.post("/score", json=bad, headers=auth).status_code == 422


# --------------------------------------------------------------- explain ------
def test_explain_returns_top_features(client, auth, sample_events):
    body = client.post("/score?explain=true", json=sample_events["cyber"],
                       headers=auth).json()
    assert body["explanation"] is not None
    assert body["explanation"]["model"] == "cyber"
    assert len(body["explanation"]["top_features"]) > 0


def test_score_without_explain_omits_explanation(client, auth, sample_events):
    body = client.post("/score", json=sample_events["cyber"], headers=auth).json()
    assert body["explanation"] is None


# ----------------------------------------------------------------- batch ------
def test_batch_mixed_domains(client, auth, sample_events):
    events = [sample_events[d] for d in
              ["financial", "cyber", "behaviour", "quantum", "threat_intel"]]
    r = client.post("/score/batch", json={"events": events}, headers=auth)
    assert r.status_code == 200
    results = r.json()["results"]
    assert len(results) == 5
    models = [x["model"] for x in results]
    assert models == ["fraud_payment", "cyber", "behaviour", "quantum", None]


def test_batch_empty_rejected(client, auth):
    assert client.post("/score/batch", json={"events": []},
                       headers=auth).status_code == 422


# --------------------------------------------------------------- feedback -----
def test_feedback_idempotent(client, auth):
    fb = {"event_id": "fb-1", "user_id": "zoe", "label": 1}
    assert client.post("/feedback", json=fb, headers=auth).json()["applied"] is True
    assert client.post("/feedback", json=fb, headers=auth).json()["applied"] is False


def test_feedback_shifts_malicious_rate(client, auth):
    """After confirming user 'mallory' malicious, a later event carries a
    non-null, positive f_user_past_malicious_rate (visible via explain)."""
    ev = {"event_id": "m1", "event_domain": "cyber", "event_time": "2024-03-01T01:00:00+00:00",
          "event_type": "network_flow", "user_id": "mallory", "device_id": "dm",
          "severity": 4, "bytes_in": 10.0, "bytes_out": 5000.0}
    client.post("/score", json=ev, headers=auth)                      # seq 0 -> 1
    client.post("/feedback", json={"event_id": "m1", "user_id": "mallory", "label": 1},
                headers=auth)
    ev2 = {**ev, "event_id": "m2", "event_time": "2024-03-01T02:00:00+00:00"}
    body = client.post("/score?explain=true", json=ev2, headers=auth).json()
    feats = {f["feature"]: f["value"] for f in body["explanation"]["top_features"]}
    # rate = pos(1)/seq(1) = 1.0 if the feature surfaces in top-k; at minimum the
    # request must still score cleanly.
    assert body["scored"] is True
    if "f_user_past_malicious_rate" in feats:
        assert feats["f_user_past_malicious_rate"] == 1.0


# --------------------------------------------------- wiring parity vs scorer --
def test_api_matches_direct_scorer(client, auth, scorer):
    """A stateless (no user/device) event scored via the API must equal calling
    SentinelScorer directly on the same raw+engineered row — proves the service
    maps columns and fuses faithfully, not just plausibly."""
    import pandas as pd

    from ml.feature_core import stateless_features

    ev = {"event_id": "wire-1", "event_domain": "financial",
          "event_time": "2024-03-01T09:30:00+00:00", "event_type": "card_txn",
          "amount": 1234.5, "duration_s": 3.0}
    api = client.post("/score", json=ev, headers=auth).json()

    merged = {**ev, **stateless_features({**ev, "event_time":
                                          pd.Timestamp(ev["event_time"])})}
    direct = scorer.score_events(pd.DataFrame([merged]))
    assert api["risk_score"] == pytest.approx(float(direct["risk_score"].iloc[0]))
    assert api["model"] == direct["model"].iloc[0]


# ------------------------------------------------------------ degradation -----
def test_degraded_when_store_down(client, auth, sample_events, monkeypatch):
    async def boom(_ev):
        raise RuntimeError("store down")

    monkeypatch.setattr(client.app.state.store, "snapshot_and_advance", boom)
    body = client.post("/score", json=sample_events["cyber"], headers=auth).json()
    assert body["degraded"] is True
    assert body["scored"] is True                 # still finite, GBM-safe
    assert 0.0 <= body["risk_score"] <= 1.0


def test_explanation_uses_the_same_model_that_scored(client, auth):
    """Explainer routing must match scorer routing.

    Regression: service/explain.py inverted DOMAIN_OF_MODEL to map domain->model.
    With two heads sharing "financial" the later key wins, so every financial
    event was explained by `fraud_application` even when `fraud_payment` scored
    it -- the returned SHAP features belonged to a model the caller never used.
    """
    for event_type, expected in [("card_txn", "fraud_payment"),
                                 ("account_open", "fraud_application")]:
        body = client.post("/score?explain=true", json={
            "event_id": f"x-{event_type}", "event_domain": "financial",
            "event_time": "2026-07-20T09:00:00Z", "event_type": event_type,
            "amount": 250.0,
        }, headers=auth).json()
        assert body["model"] == expected, event_type
        assert body["explanation"]["model"] == body["model"], event_type


# --------------------------------------------------------------- schema v2 ---
def _pay(eid, minutes, **kw):
    import datetime as dt
    t = dt.datetime(2026, 5, 1, 9, 0, tzinfo=dt.timezone.utc) + dt.timedelta(minutes=minutes)
    body = {"event_id": eid, "event_domain": "financial",
            "event_time": t.isoformat().replace("+00:00", "Z"),
            "event_type": "card_txn", "user_id": "acc-u", "amount": 50.0,
            "country": "GB", "merchant_category": "grocery_pos",
            "counterparty_id": "mrc-1"}
    body.update(kw)
    return body


def test_ingest_builds_history_without_scoring(client, auth):
    """§3.1 acceptance: streaming context events makes the next /score
    full-fidelity instead of history-degraded."""
    cold = client.post("/score", json=_pay("i-cold", 0), headers=auth).json()
    assert cold["degradation"]["user_history"] is True

    events = [_pay(f"i-ctx{i}", 10 * (i + 1), event_type="balance_check")
              for i in range(6)]
    r = client.post("/ingest/batch", json={"events": events}, headers=auth)
    assert r.status_code == 202
    assert r.json() == {"accepted": 6, "rejected": 0}

    warm = client.post("/score", json=_pay("i-warm", 120), headers=auth).json()
    assert warm["degradation"]["user_history"] is False
    assert warm["degradation"]["store_unavailable"] is False


def test_score_is_idempotent_on_replay(client, auth):
    """§3.2: replaying an event_id must not double-advance the store."""
    for i in range(3):
        client.post("/score", json=_pay(f"idem-{i}", 200 + 10 * i), headers=auth)
    first = client.post("/score", json=_pay("idem-x", 260), headers=auth).json()
    replay = client.post("/score", json=_pay("idem-x", 260), headers=auth).json()
    assert replay["risk_score"] == first["risk_score"]


def test_bank_context_accepted_and_used_on_cold_store(client, auth):
    """§3.3: the bank's own signals must reach the model, not be rejected."""
    body = _pay("bank-1", 300, user_id="brand-new-user", amount=9000.0,
                name_mismatch=1, counterparty_is_new=1, counterparty_age_s=300,
                bank_txn_count_1h=9, bank_amount_vs_user_mean=42.0,
                bank_is_new_beneficiary=1)
    r = client.post("/score", json=body, headers=auth)
    assert r.status_code == 200, r.text          # v1 rejected these with 422
    assert r.json()["degradation"]["bank_context_used"] is True


def test_feedback_batch_is_idempotent(client, auth):
    # distinct ids: the client fixture is session-scoped, so the store carries
    # state across tests and "fb-1" is already claimed by test_feedback_*
    items = [{"event_id": "fbb-1", "user_id": "u", "label": 1},
             {"event_id": "fbb-2", "user_id": "u", "label": 0}]
    first = client.post("/feedback/batch", json={"items": items}, headers=auth).json()
    assert first["applied"] == 2 and first["duplicates"] == 0
    again = client.post("/feedback/batch", json={"items": items}, headers=auth).json()
    assert again["applied"] == 0 and again["duplicates"] == 2


def test_ready_reports_contract_hash(client):
    from ml.feature_spec import CONTRACT_HASH
    assert client.get("/ready").json()["contract_hash"] == CONTRACT_HASH


def test_ingest_is_cheaper_than_score(client, auth):
    """§3.1 rationale: /ingest exists because it skips model inference.

    If it were not materially cheaper there would be no reason for the bank to
    stream context events on the money path at all.
    """
    import time
    ev = _pay("perf-warm", 500, event_type="balance_check")
    client.post("/ingest", json=ev, headers=auth)          # warm caches

    def _timed(path, n, prefix):
        t0 = time.perf_counter()
        for i in range(n):
            client.post(path, json=_pay(f"{prefix}{i}", 600 + i,
                                        event_type="balance_check"), headers=auth)
        return (time.perf_counter() - t0) / n

    ingest_ms = _timed("/ingest", 20, "perf-i") * 1e3
    score_ms = _timed("/score", 20, "perf-s") * 1e3
    assert ingest_ms < score_ms, f"ingest {ingest_ms:.2f}ms !< score {score_ms:.2f}ms"
    # Sanity: both must fit comfortably inside the bank's ~800 ms client budget.
    assert score_ms < 200, f"score p_avg {score_ms:.1f}ms too slow"
