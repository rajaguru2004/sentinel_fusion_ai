"""Lock online == offline feature semantics.

Two guarantees:

1. ``engineer_batch`` (offline reference, mirrors notebook 12) == incremental
   per-event replay (the online serving path) on a synthetic raw-event frame
   that exercises multi-event users/devices, missing amounts/countries, unseen
   countries, and label-driven malicious rate.
2. The stateless features computed per-event equal the ``f_*`` columns already
   baked into the committed mini fixture (which trained the real models).

The mini fixture drops raw ``user_id``/``device_id``/``severity`` (not model
features), so stateful parity is proven on the synthetic frame instead.
"""
from __future__ import annotations

from dataclasses import replace

import numpy as np
import pandas as pd
import pytest

from ml import feature_core as fc


def _present(v) -> bool:
    """A value the offline path would count as non-null.

    NOT just ``v is not None``: ``DataFrame.iterrows()`` converts ``None`` in an
    object column to ``nan``, so a naive check treats absent entities as present
    and the replay diverges from ``engineer_batch`` on exactly those rows. The
    serving path has the same guard in ``service.store._entity_id``.
    """
    return not (v is None or (isinstance(v, float) and np.isnan(v)))


def _replay(df: pd.DataFrame) -> pd.DataFrame:
    """Row-by-row online path, feeding the ground-truth label into ``pos`` so the
    malicious-rate formula matches the offline (instant-label) reference.

    Set membership (country / counterparty / merchant-category) and the sliding
    velocity window live here rather than on ``UserState``, mirroring how the
    real store keeps them: scalar counters in the entity hash, sets in Redis
    SETs, recent timestamps in a ZSET.
    """
    users: dict[str, fc.UserState] = {}
    devices: dict[str, fc.DeviceState] = {}
    seen_uc: set[tuple[str, str]] = set()
    seen_cp: set[tuple[str, str]] = set()
    seen_mcc: set[tuple[str, str]] = set()
    cps: dict[str, set[str]] = {}
    window: dict[str, list[float]] = {}
    rows = []
    for _, r in df.iterrows():
        ev = r.to_dict()
        feats = dict(fc.stateless_features(ev))

        uid = ev.get("user_id")
        if _present(uid):
            ust = users.get(uid, fc.UserState())
            country, cp = ev.get("country"), ev.get("counterparty_id")
            mcc = ev.get("merchant_category")
            now = pd.Timestamp(ev["event_time"]).timestamp()
            recent = window.setdefault(uid, [])
            feats.update(fc.user_features(
                ust, ev,
                seen_country=_present(country) and (uid, country) in seen_uc,
                seen_counterparty=_present(cp) and (uid, cp) in seen_cp,
                n_counterparties=len(cps.get(uid, set())),
                seen_merchant_category=_present(mcc) and (uid, mcc) in seen_mcc,
                txn_count_window=sum(1 for t in recent
                                     if t >= now - fc.TXN_WINDOW_S)))
            ust = fc.advance_user(ust, ev)
            if ev.get("label") == 1:                       # feedback, instantly
                ust = replace(ust, pos=ust.pos + 1)
            users[uid] = ust
            if _present(country):
                seen_uc.add((uid, country))
            if _present(cp):
                seen_cp.add((uid, cp))
                cps.setdefault(uid, set()).add(cp)
            if _present(mcc):
                seen_mcc.add((uid, mcc))
            recent.append(now)

        did = ev.get("device_id")
        if _present(did):
            dst = devices.get(did, fc.DeviceState())
            feats.update(fc.device_features(dst))
            devices[did] = fc.advance_device(dst, ev)

        rows.append(feats)
    return pd.DataFrame(rows, index=df.index)


def _synthetic_frame() -> pd.DataFrame:
    base = pd.Timestamp("2024-01-01 00:00:00", tz="UTC")
    recs = []
    # user A: 4 financial events, varying amounts, 2 countries, one malicious
    for i, (amt, cty, lab) in enumerate([(100.0, "US", 0), (200.0, "US", 0),
                                         (50.0, "GB", 1), (400.0, "US", 0)]):
        recs.append(dict(event_id=f"a-{i}", event_time=base + pd.Timedelta(hours=i),
                         user_id="A", device_id="D1", amount=amt, country=cty,
                         severity=1 if lab == 0 else 4, label=lab,
                         bytes_in=np.nan, bytes_out=np.nan))
    # user B: 3 cyber events on 2 devices, high severity, no amount
    for i, (dev, sev, lab) in enumerate([("D2", 4, 1), ("D2", 2, 0), ("D3", 3, 1)]):
        recs.append(dict(event_id=f"b-{i}", event_time=base + pd.Timedelta(hours=10 + i),
                         user_id="B", device_id=dev, amount=np.nan, country="DE",
                         severity=sev, label=lab,
                         bytes_in=float(100 * (i + 1)), bytes_out=float(50 * (i + 1))))
    # singletons: first-event NaNs, missing country
    recs.append(dict(event_id="c-0", event_time=base + pd.Timedelta(hours=20),
                     user_id="C", device_id=np.nan, amount=999.0, country=np.nan,
                     severity=0, label=0, bytes_in=np.nan, bytes_out=np.nan))

    # user E: banking payments. Exercises counterparty novelty//distinct count,
    # merchant-category novelty, balances (incl. one balance-equation violation)
    # and geo. Timings straddle the velocity window: the 90-minute gap must push
    # earlier events OUT of f_user_txn_count_1h.
    pay = [  # (minutes, amount, counterparty, mcc, bal_before, bal_after, credit)
        (0,    100.0, "P1", "grocery", 5000.0, 4900.0, 0),
        (10,   250.0, "P1", "grocery", 4900.0, 4650.0, 0),
        (20,   300.0, "P2", "travel",  4650.0, 4350.0, 0),
        (30,  4000.0, "P3", "travel",  4350.0,  350.0, 0),   # near-drain
        (120,   75.0, "P2", "grocery",  350.0,  262.0, 0),   # >1h gap; inconsistent
        (125,  500.0, "P4", None,       262.0,  762.0, 1),   # credit in
    ]
    for i, (mins, amt, cp, mcc, bb, ba, cr) in enumerate(pay):
        recs.append(dict(event_id=f"e-{i}",
                         event_time=base + pd.Timedelta(hours=30, minutes=mins),
                         user_id="E", device_id="D4", amount=amt, country="GB",
                         severity=0, label=0, bytes_in=np.nan, bytes_out=np.nan,
                         counterparty_id=cp, merchant_category=mcc,
                         balance_before=bb, balance_after=ba, is_credit=cr,
                         geo_lat=51.5, geo_lon=-0.12,
                         counterparty_lat=48.85, counterparty_lon=2.35))

    # user F: two identical amounts, then a third. E[x^2]-E[x]^2 cancels to ~0
    # here, and the offline (cumsum) and online (sequential) sums leave DIFFERENT
    # floating-point residue -- the case that produced offline z=1.5e7 vs online
    # z=NaN before _past_std()'s relative epsilon guard.
    for i, amt in enumerate([1000.0, 1000.0, 1000.0, 1500.0]):
        recs.append(dict(event_id=f"f-{i}",
                         event_time=base + pd.Timedelta(hours=40, minutes=i),
                         user_id="F", device_id=np.nan, amount=amt, country="FR",
                         severity=0, label=0, bytes_in=np.nan, bytes_out=np.nan))

    df = pd.DataFrame(recs)
    df["event_time"] = pd.to_datetime(df["event_time"], utc=True)
    return df.sort_values(["event_time", "event_id"]).reset_index(drop=True)


def _assert_col_equal(a: pd.Series, b: pd.Series, name: str) -> None:
    av = pd.to_numeric(a, errors="coerce").to_numpy(dtype="float64")
    bv = pd.to_numeric(b, errors="coerce").to_numpy(dtype="float64")
    assert np.allclose(av, bv, rtol=1e-9, atol=1e-9, equal_nan=True), (
        f"{name} mismatch:\noffline={av}\nonline ={bv}")


def test_stateful_parity_offline_vs_online():
    df = _synthetic_frame()
    ref = fc.engineer_batch(df)
    online = _replay(df)
    for col in fc.ENGINEERED_F:
        assert col in online.columns or col in fc.USER_STATEFUL_F + fc.DEVICE_STATEFUL_F
        if col in online.columns:
            _assert_col_equal(ref[col], online[col], col)


def test_stateless_parity_against_mini_fixture(fixture_frame):
    """Stateless f_* recomputed per-event must equal the fixture's baked columns."""
    df = fixture_frame.head(500)
    online = pd.DataFrame([fc.stateless_features(r) for _, r in df.iterrows()],
                          index=df.index)
    for col in fc.STATELESS_F:
        if col in df.columns:
            _assert_col_equal(df[col], online[col], col)


@pytest.mark.parametrize("col", fc.STATELESS_TEMPORAL)
def test_stateless_temporal_present(col):
    ev = {"event_time": pd.Timestamp("2024-06-15 03:00:00", tz="UTC")}
    feats = fc.stateless_features(ev)
    assert col in feats and np.isfinite(feats[col])


def test_velocity_window_actually_expires():
    """f_user_txn_count_1h must DROP events older than the window.

    Regression: the offline path derived epoch seconds with a hardcoded
    nanosecond divisor, but pandas 3 stores these as datetime64[us]. The
    resulting timestamps were 1/1000 of the true epoch, so `t - 3600` never
    excluded anything and the feature silently degenerated into "count of all
    prior events" -- monotonically increasing, never expiring.
    """
    base = pd.Timestamp("2024-03-01", tz="UTC")
    offsets = [0, 100, 200, 3500, 3700, 7400]
    df = pd.DataFrame({
        "event_id": [f"v-{i}" for i in range(len(offsets))],
        "event_time": [base + pd.Timedelta(seconds=s) for s in offsets],
        "user_id": ["U"] * len(offsets),
        "amount": [1.0] * len(offsets),
    })
    got = fc.engineer_batch(df)["f_user_txn_count_1h"].tolist()
    expected = [sum(1 for p in offsets[:i] if p >= t - fc.TXN_WINDOW_S)
                for i, t in enumerate(offsets)]
    assert expected == [0, 1, 2, 3, 3, 0]      # pin the intent, not just the impl
    assert got == pytest.approx(expected)


def test_amount_z_stable_for_near_constant_user():
    """Near-zero variance must yield NaN in BOTH paths, not a 1e7 z-score."""
    base = pd.Timestamp("2024-04-01", tz="UTC")
    df = pd.DataFrame({
        "event_id": [f"z-{i}" for i in range(4)],
        "event_time": [base + pd.Timedelta(minutes=i) for i in range(4)],
        "user_id": ["Z"] * 4,
        "amount": [1000.0, 1000.0, 1000.0, 1000.0],
    })
    offline = fc.engineer_batch(df)["f_amount_z_user"]
    online = _replay(df)["f_amount_z_user"]
    # identical amounts -> zero spread -> undefined z, both paths
    assert offline.isna().all(), f"offline produced {offline.tolist()}"
    assert online.isna().all(), f"online produced {online.tolist()}"


def test_first_event_user_features_are_nan():
    st = fc.UserState()
    feats = fc.user_features(st, {"event_time": pd.Timestamp("2024-01-01", tz="UTC"),
                                  "amount": 100.0, "country": "US"}, seen_country=False)
    assert feats["f_user_seq_no"] == 0.0
    assert np.isnan(feats["f_user_secs_since_last"])
    assert np.isnan(feats["f_user_past_malicious_rate"])
    assert np.isnan(feats["f_amount_z_user"])       # no prior amounts
    assert feats["f_user_new_country"] == 1.0       # first time this country
