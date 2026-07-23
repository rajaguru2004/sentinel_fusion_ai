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


def _replay(df: pd.DataFrame) -> pd.DataFrame:
    """Row-by-row online path, feeding the ground-truth label into ``pos`` so the
    malicious-rate formula matches the offline (instant-label) reference."""
    users: dict[str, fc.UserState] = {}
    devices: dict[str, fc.DeviceState] = {}
    seen_uc: set[tuple[str, str]] = set()
    rows = []
    for _, r in df.iterrows():
        ev = r.to_dict()
        feats = dict(fc.stateless_features(ev))

        uid = ev.get("user_id")
        if uid is not None and not (isinstance(uid, float) and np.isnan(uid)):
            ust = users.get(uid, fc.UserState())
            country = ev.get("country")
            has_country = country is not None and not (
                isinstance(country, float) and np.isnan(country))
            seen = has_country and (uid, country) in seen_uc
            feats.update(fc.user_features(ust, ev, seen_country=seen))
            ust = fc.advance_user(ust, ev)
            if ev.get("label") == 1:                       # feedback, instantly
                ust = replace(ust, pos=ust.pos + 1)
            users[uid] = ust
            if has_country:
                seen_uc.add((uid, country))

        did = ev.get("device_id")
        if did is not None and not (isinstance(did, float) and np.isnan(did)):
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


def test_first_event_user_features_are_nan():
    st = fc.UserState()
    feats = fc.user_features(st, {"event_time": pd.Timestamp("2024-01-01", tz="UTC"),
                                  "amount": 100.0, "country": "US"}, seen_country=False)
    assert feats["f_user_seq_no"] == 0.0
    assert np.isnan(feats["f_user_secs_since_last"])
    assert np.isnan(feats["f_user_past_malicious_rate"])
    assert np.isnan(feats["f_amount_z_user"])       # no prior amounts
    assert feats["f_user_new_country"] == 1.0       # first time this country
