"""Canonical engineered-feature semantics — the single source of truth shared
by offline training and online serving.

The training corpus features (``f_*``) are produced offline by whole-corpus
vectorized ``groupby.cumsum/cumcount`` (see ``notebooks/src/12_feature_engineering.py``).
Serving must reproduce those *exact* values from incremental per-entity state,
or training/serving silently diverge. This module defines the math once, two
ways that are proven equal by ``tests/unit/test_feature_parity.py``:

* :func:`engineer_batch` — vectorized, mirrors the notebook (offline / reference).
* :func:`stateless_features` + :class:`UserState`/:class:`DeviceState` with
  :func:`user_features`/:func:`device_features`/:func:`advance_user`/
  :func:`advance_device` — incremental, one event at a time (online / serving).

All historical features are PAST-only (exclude the current row): read state,
emit features, *then* advance state with the current event. ``UserState.pos``
(malicious count) is never advanced at scoring time — the label is unknown then;
it is updated out-of-band via the feedback path.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Any, Mapping

import numpy as np
import pandas as pd

# Feature-name groups (kept in sync with ml.config FEATURES).
STATELESS_TEMPORAL = ["f_hour", "f_dayofweek", "f_is_weekend", "f_is_night",
                      "f_hour_sin", "f_hour_cos"]
STATELESS_TRANSFORM = ["f_log1p_amount", "f_log1p_bytes_in", "f_log1p_bytes_out",
                       "f_bytes_ratio"]
STATELESS_F = [*STATELESS_TEMPORAL, *STATELESS_TRANSFORM]
USER_STATEFUL_F = ["f_user_seq_no", "f_user_secs_since_last",
                   "f_user_past_malicious_rate", "f_user_new_country",
                   "f_amount_z_user", "f_amount_ratio_mean"]
DEVICE_STATEFUL_F = ["f_device_seq_no", "f_device_past_hisev_count"]
ENGINEERED_F = [*STATELESS_F, *USER_STATEFUL_F, *DEVICE_STATEFUL_F]

_NIGHT_HOURS = frozenset({0, 1, 2, 3, 4, 5})


# --------------------------------------------------------------- helpers ------
def _num(v: Any) -> float:
    """Coerce to float; None / NaN / unparseable -> nan."""
    if v is None:
        return math.nan
    try:
        f = float(v)
    except (TypeError, ValueError):
        return math.nan
    return f


def _as_datetime(v: Any) -> pd.Timestamp:
    return pd.Timestamp(v)


# ------------------------------------------------------------- stateless ------
def stateless_features(ev: Mapping[str, Any]) -> dict[str, float]:
    """Event-only features (no history). ``ev`` needs ``event_time`` and,
    where relevant, ``amount``/``bytes_in``/``bytes_out``. Mirrors notebook §1,§3,§4
    stateless lines exactly (log1p, bytes ratio, cyclical hour)."""
    t = _as_datetime(ev["event_time"])
    hour = t.hour
    dow = t.weekday()  # Mon=0, matches pandas dt.dayofweek
    amount = _num(ev.get("amount"))
    bytes_in = _num(ev.get("bytes_in"))
    bytes_out = _num(ev.get("bytes_out"))
    return {
        "f_hour": float(hour),
        "f_dayofweek": float(dow),
        "f_is_weekend": float(dow >= 5),
        "f_is_night": float(hour in _NIGHT_HOURS),
        "f_hour_sin": math.sin(2 * math.pi * hour / 24),
        "f_hour_cos": math.cos(2 * math.pi * hour / 24),
        "f_log1p_amount": math.log1p(amount) if not math.isnan(amount) else math.nan,
        "f_log1p_bytes_in": math.log1p(bytes_in) if not math.isnan(bytes_in) else math.nan,
        "f_log1p_bytes_out": math.log1p(bytes_out) if not math.isnan(bytes_out) else math.nan,
        # f_bytes_ratio = bytes_out / (bytes_in + 1); nan propagates like the notebook.
        "f_bytes_ratio": bytes_out / (bytes_in + 1.0),
    }


# ----------------------------------------------------------- entity state -----
@dataclass(frozen=True)
class UserState:
    """Per-user running aggregates (all counts are PRIOR-event counts).

    seq       — number of prior events (any).
    last_ts   — epoch seconds of the user's previous event (None if none).
    amt_n     — number of prior events that carried an ``amount``.
    amt_sum   — sum of those prior amounts.
    amt_sumsq — sum of squares of those prior amounts.
    pos       — number of prior events confirmed malicious (feedback-driven).
    """
    seq: int = 0
    last_ts: float | None = None
    amt_n: int = 0
    amt_sum: float = 0.0
    amt_sumsq: float = 0.0
    pos: int = 0


@dataclass(frozen=True)
class DeviceState:
    seq: int = 0      # prior events on this device
    hisev: int = 0    # prior events with severity >= 3


def user_features(st: UserState, ev: Mapping[str, Any], *,
                  seen_country: bool) -> dict[str, float]:
    """PAST-only user features from ``st`` (state BEFORE this event).

    ``seen_country`` = has this (user, country) pair occurred before? Only
    meaningful when ``country`` is present; when absent the flag is NaN (the
    offline path never assigns it for null-country rows).
    """
    out: dict[str, float] = {}
    out["f_user_seq_no"] = float(st.seq)

    now = _num(ev.get("event_time_epoch"))
    if math.isnan(now):
        now = _as_datetime(ev["event_time"]).timestamp()
    out["f_user_secs_since_last"] = (math.nan if st.last_ts is None
                                     else now - st.last_ts)

    # past malicious rate = prior positives / prior event count; 0 priors -> nan
    out["f_user_past_malicious_rate"] = (st.pos / st.seq if st.seq > 0 else math.nan)

    country = ev.get("country")
    out["f_user_new_country"] = (math.nan if country is None or
                                 (isinstance(country, float) and math.isnan(country))
                                 else float(not seen_country))

    amount = _num(ev.get("amount"))
    if math.isnan(amount) or st.amt_n == 0:
        # no current amount, or no prior amounts to compare against -> nan (offline
        # divides by n_prior.replace(0, nan) and only assigns where amount present)
        out["f_amount_z_user"] = math.nan
        out["f_amount_ratio_mean"] = math.nan
    else:
        past_mean = st.amt_sum / st.amt_n
        past_var = st.amt_sumsq / st.amt_n - past_mean * past_mean
        past_std = math.sqrt(past_var) if past_var > 0 else 0.0
        out["f_amount_z_user"] = ((amount - past_mean) / past_std
                                  if past_std != 0 else math.nan)
        out["f_amount_ratio_mean"] = (amount / past_mean if past_mean != 0 else math.nan)
    return out


def device_features(st: DeviceState) -> dict[str, float]:
    return {"f_device_seq_no": float(st.seq),
            "f_device_past_hisev_count": float(st.hisev)}


def advance_user(st: UserState, ev: Mapping[str, Any]) -> UserState:
    """State AFTER folding the current event (pos is untouched — see module doc)."""
    now = _num(ev.get("event_time_epoch"))
    if math.isnan(now):
        now = _as_datetime(ev["event_time"]).timestamp()
    amount = _num(ev.get("amount"))
    has_amt = not math.isnan(amount)
    return replace(
        st,
        seq=st.seq + 1,
        last_ts=now,
        amt_n=st.amt_n + (1 if has_amt else 0),
        amt_sum=st.amt_sum + (amount if has_amt else 0.0),
        amt_sumsq=st.amt_sumsq + (amount * amount if has_amt else 0.0),
    )


def advance_device(st: DeviceState, ev: Mapping[str, Any]) -> DeviceState:
    sev = _num(ev.get("severity"))
    is_hi = (not math.isnan(sev)) and sev >= 3
    return replace(st, seq=st.seq + 1, hisev=st.hisev + (1 if is_hi else 0))


def is_high_severity(ev: Mapping[str, Any]) -> bool:
    sev = _num(ev.get("severity"))
    return (not math.isnan(sev)) and sev >= 3


# ------------------------------------------------------- offline reference ----
def engineer_batch(df: pd.DataFrame) -> pd.DataFrame:
    """Vectorized engineering — reproduces ``notebooks/src/12_feature_engineering.py``.

    Adds the ``f_*`` columns to a copy of ``df`` (assumed already sorted by
    ``event_time, event_id``). Used as the offline reference the incremental
    path is proven equal to. Columns absent from ``df`` are treated as all-NaN.
    """
    df = df.copy()
    for c in ("amount", "bytes_in", "bytes_out", "severity", "label",
              "user_id", "device_id", "country"):
        if c not in df.columns:
            df[c] = np.nan

    # Normalise event_time to datetime so per-entity diffs work regardless of the
    # source dtype (parquet/csv may hand us strings).
    df["event_time"] = pd.to_datetime(df["event_time"], utc=True)

    # 1. Temporal
    t = df["event_time"]
    df["f_hour"] = t.dt.hour.astype("int64")
    df["f_dayofweek"] = t.dt.dayofweek.astype("int64")
    df["f_is_weekend"] = (df["f_dayofweek"] >= 5).astype("int64")
    df["f_is_night"] = df["f_hour"].isin(list(_NIGHT_HOURS)).astype("int64")
    df["f_hour_sin"] = np.sin(2 * np.pi * df["f_hour"] / 24)
    df["f_hour_cos"] = np.cos(2 * np.pi * df["f_hour"] / 24)

    # 2. Behavioural per-user (past-only)
    has_user = df["user_id"].notna()
    if has_user.any():
        sub = df.loc[has_user]
        g = sub.groupby("user_id", observed=True, sort=False)
        seq = g.cumcount()
        df.loc[has_user, "f_user_seq_no"] = seq
        df.loc[has_user, "f_user_secs_since_last"] = (
            g["event_time"].diff().dt.total_seconds())
        is_pos = sub["label"].eq(1).astype("float64")
        cum_pos = is_pos.groupby(sub["user_id"], observed=True, sort=False).cumsum()
        df.loc[has_user, "f_user_past_malicious_rate"] = (
            (cum_pos - is_pos) / seq.replace(0, np.nan))
        has_uc = has_user & df["country"].notna()
        uc = df.loc[has_uc]
        df.loc[has_uc, "f_user_new_country"] = (
            uc.groupby(["user_id", "country"], observed=True, sort=False)
            .cumcount().eq(0).astype("float64"))

    # 3. Transactional per-user (past-only moments)
    has_amt = has_user & df["amount"].notna()
    if has_amt.any():
        a = df.loc[has_amt, ["user_id", "amount"]]
        ga = a.groupby("user_id", observed=True, sort=False)["amount"]
        n_prior = ga.cumcount()
        cs = ga.cumsum() - a["amount"]
        cs2 = ((a["amount"] ** 2).groupby(a["user_id"], observed=True, sort=False)
               .cumsum() - a["amount"] ** 2)
        past_mean = cs / n_prior.replace(0, np.nan)
        past_var = (cs2 / n_prior.replace(0, np.nan)) - past_mean ** 2
        past_std = np.sqrt(past_var.clip(lower=0))
        df.loc[has_amt, "f_amount_z_user"] = (
            (a["amount"] - past_mean) / past_std.replace(0, np.nan))
        df.loc[has_amt, "f_amount_ratio_mean"] = a["amount"] / past_mean.replace(0, np.nan)
    df["f_log1p_amount"] = np.log1p(df["amount"])

    # 4. Volume + device history
    df["f_log1p_bytes_out"] = np.log1p(df["bytes_out"])
    df["f_log1p_bytes_in"] = np.log1p(df["bytes_in"])
    df["f_bytes_ratio"] = df["bytes_out"] / (df["bytes_in"] + 1)
    has_dev = df["device_id"].notna()
    if has_dev.any():
        d = df.loc[has_dev]
        gd = d.groupby("device_id", observed=True, sort=False)
        df.loc[has_dev, "f_device_seq_no"] = gd.cumcount()
        hisev = d["severity"].ge(3).astype("float64")
        cum_hisev = hisev.groupby(d["device_id"], observed=True, sort=False).cumsum()
        df.loc[has_dev, "f_device_past_hisev_count"] = cum_hisev - hisev
    return df
