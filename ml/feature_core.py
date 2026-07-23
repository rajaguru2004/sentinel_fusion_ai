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

# Feature-name groups now come from THE contract (ml.feature_spec) rather than
# being re-declared here — this module used to hold a hand-synced second copy.
from .feature_spec import (  # noqa: E402
    DEVICE_STATEFUL_F,
    ENGINEERED_F,
    STATELESS_BANKING,
    STATELESS_F,
    STATELESS_TEMPORAL,
    STATELESS_TRANSFORM,
    TXN_WINDOW_S,
    USER_STATEFUL_F,
)

__all__ = ["STATELESS_TEMPORAL", "STATELESS_TRANSFORM", "STATELESS_BANKING",
           "STATELESS_F", "USER_STATEFUL_F", "DEVICE_STATEFUL_F", "ENGINEERED_F",
           "TXN_WINDOW_S", "UserState", "DeviceState", "stateless_features",
           "user_features", "device_features", "advance_user", "advance_device",
           "is_high_severity", "engineer_batch"]

_NIGHT_HOURS = frozenset({0, 1, 2, 3, 4, 5})
_EARTH_R_KM = 6371.0
_EPOCH = pd.Timestamp(0, tz="UTC")

# Running variance is computed as E[x^2] - E[x]^2, which catastrophically
# cancels when a user's past amounts are near-identical: the true variance is
# ~0 but floating point leaves a tiny positive or negative residue, and the
# offline (cumsum) and online (sequential add) paths do not produce the SAME
# residue. Without a guard that single difference turns into offline z = 1.5e7
# vs online z = NaN. Treat any variance below this fraction of the mean-square
# as exactly zero, in BOTH paths, so the outcome is deterministic.
_VAR_EPS_REL = 1e-9


def _past_std(n: float, s: float, s2: float) -> float:
    """Std-dev of a user's PAST amounts from running moments; 0.0 when the
    spread is numerically indistinguishable from zero."""
    mean = s / n
    var = s2 / n - mean * mean
    if var <= _VAR_EPS_REL * max(mean * mean, 1.0):
        return 0.0
    return math.sqrt(var)


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
def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    if any(math.isnan(v) for v in (lat1, lon1, lat2, lon2)):
        return math.nan
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_R_KM * math.asin(math.sqrt(a))


def stateless_features(ev: Mapping[str, Any]) -> dict[str, float]:
    """Event-only features (no history). ``ev`` needs ``event_time`` and,
    where relevant, ``amount``/``bytes_in``/``bytes_out``/balances/geo. Offline
    and online agree trivially here — there is no state to diverge."""
    t = _as_datetime(ev["event_time"])
    hour = t.hour
    dow = t.weekday()  # Mon=0, matches pandas dt.dayofweek
    amount = _num(ev.get("amount"))
    bytes_in = _num(ev.get("bytes_in"))
    bytes_out = _num(ev.get("bytes_out"))

    bal_b = _num(ev.get("balance_before"))
    bal_a = _num(ev.get("balance_after"))
    is_credit = _num(ev.get("is_credit"))

    # Balance-equation violation. Sign follows direction: a credit should raise
    # the balance by `amount`, a debit should lower it. PaySim's own
    # `orig_balance_inconsistent` is the debit case of this; computing it here
    # from canonical columns makes it available to the bank at serving time
    # instead of being a source-local artifact.
    if math.isnan(bal_b) or math.isnan(bal_a) or math.isnan(amount):
        inconsistent = math.nan
    else:
        signed = amount if is_credit == 1.0 else -amount
        inconsistent = float(abs((bal_b + signed) - bal_a) > 0.01)

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
        # --- banking ---
        # Share of the balance the transaction removes; ~1.0 is a drain-to-zero,
        # the classic PaySim/APP-fraud pattern.
        "f_balance_drain_ratio": ((bal_b - bal_a) / (bal_b + 1.0)
                                  if not (math.isnan(bal_b) or math.isnan(bal_a))
                                  else math.nan),
        "f_amount_vs_balance": (amount / (bal_b + 1.0)
                                if not (math.isnan(amount) or math.isnan(bal_b))
                                else math.nan),
        "f_balance_inconsistent": inconsistent,
        "f_geo_distance_km": _haversine_km(
            _num(ev.get("geo_lat")), _num(ev.get("geo_lon")),
            _num(ev.get("counterparty_lat")), _num(ev.get("counterparty_lon"))),
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


def _absent(v: Any) -> bool:
    return v is None or (isinstance(v, float) and math.isnan(v))


def user_features(st: UserState, ev: Mapping[str, Any], *,
                  seen_country: bool,
                  seen_counterparty: bool = False,
                  n_counterparties: int = 0,
                  seen_merchant_category: bool = False,
                  txn_count_window: int = 0) -> dict[str, float]:
    """PAST-only user features from ``st`` (state BEFORE this event).

    The set-membership flags are supplied by the store rather than held on
    :class:`UserState`, matching how ``seen_country`` already works: scalar
    counters live on the state, set membership lives in the store (a Redis SET
    per user, or a dict-of-sets in-memory).

    ``seen_country`` / ``seen_counterparty`` / ``seen_merchant_category`` = has
    this (user, X) pair occurred before? Each is NaN when its raw column is
    absent — the offline path never assigns a value for null rows, so the online
    path must not either.
    ``n_counterparties`` = distinct counterparties before this event.
    ``txn_count_window`` = user's events within the last ``TXN_WINDOW_S``,
    excluding this one.
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
    out["f_user_new_country"] = (math.nan if _absent(country)
                                 else float(not seen_country))

    # Counterparty novelty: the model-side view of the bank's `isNewBeneficiary`.
    cp = ev.get("counterparty_id")
    out["f_counterparty_new"] = (math.nan if _absent(cp)
                                 else float(not seen_counterparty))
    out["f_user_distinct_counterparties"] = float(n_counterparties)

    mcc = ev.get("merchant_category")
    out["f_merchant_category_novel"] = (math.nan if _absent(mcc)
                                        else float(not seen_merchant_category))

    out["f_user_txn_count_1h"] = float(txn_count_window)

    amount = _num(ev.get("amount"))
    if math.isnan(amount) or st.amt_n == 0:
        # no current amount, or no prior amounts to compare against -> nan (offline
        # divides by n_prior.replace(0, nan) and only assigns where amount present)
        out["f_amount_z_user"] = math.nan
        out["f_amount_ratio_mean"] = math.nan
    else:
        past_mean = st.amt_sum / st.amt_n
        past_std = _past_std(st.amt_n, st.amt_sum, st.amt_sumsq)
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
              "user_id", "device_id", "country",
              "balance_before", "balance_after", "is_credit",
              "geo_lat", "geo_lon", "counterparty_lat", "counterparty_lon",
              "counterparty_id", "merchant_category"):
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

        # -- counterparty novelty + running distinct count --------------------
        has_cp = has_user & df["counterparty_id"].notna()
        if has_cp.any():
            cp = df.loc[has_cp]
            is_new_cp = (cp.groupby(["user_id", "counterparty_id"], observed=True,
                                    sort=False).cumcount().eq(0).astype("float64"))
            # NaN where this event has no counterparty: the flag describes the
            # event's counterparty, so it is undefined without one.
            df.loc[has_cp, "f_counterparty_new"] = is_new_cp

            # ...whereas the distinct count describes the USER, so it is defined
            # on every event of a known user (a login still happens against a
            # customer who has N payees). Spread first-sightings over all of the
            # user's rows, then shift by the current row's own contribution.
            new_all = pd.Series(0.0, index=sub.index)
            new_all.loc[cp.index] = is_new_cp
            cum_new = new_all.groupby(sub["user_id"], observed=True, sort=False).cumsum()
            df.loc[has_user, "f_user_distinct_counterparties"] = cum_new - new_all

        has_mcc = has_user & df["merchant_category"].notna()
        if has_mcc.any():
            mc = df.loc[has_mcc]
            df.loc[has_mcc, "f_merchant_category_novel"] = (
                mc.groupby(["user_id", "merchant_category"], observed=True,
                           sort=False).cumcount().eq(0).astype("float64"))

        # -- sliding-window velocity ------------------------------------------
        # Prior events by this user within TXN_WINDOW_S. df is time-sorted, so
        # each group's timestamps are ascending and searchsorted applies.
        # count_i = i - first index whose time >= t_i - W  (excludes row i).
        # Epoch seconds, unit-independent. NOT `.astype("int64") // 1e9`:
        # pandas 3 stores these as datetime64[us], so a hardcoded nanosecond
        # divisor silently yields 1/1000 of the real epoch and the window never
        # fires. total_seconds() also matches Timestamp.timestamp(), which is
        # what the online path uses.
        secs = (df.loc[has_user, "event_time"] - _EPOCH).dt.total_seconds()
        win = np.empty(len(secs), dtype="float64")
        secs_np = secs.to_numpy()
        # .indices gives positional offsets into `sub`, which `secs`/`win` share.
        for gidx in sub.groupby("user_id", observed=True, sort=False).indices.values():
            gidx = np.sort(gidx)
            ts = secs_np[gidx]
            lo = np.searchsorted(ts, ts - TXN_WINDOW_S, side="left")
            win[gidx] = np.arange(len(ts)) - lo
        df.loc[has_user, "f_user_txn_count_1h"] = win

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
        # Same cancellation guard as _past_std(), applied identically here so the
        # vectorized and incremental paths cannot disagree on near-constant users.
        past_var = past_var.where(
            past_var > _VAR_EPS_REL * np.maximum(past_mean ** 2, 1.0), 0.0)
        past_std = np.sqrt(past_var)
        df.loc[has_amt, "f_amount_z_user"] = (
            (a["amount"] - past_mean) / past_std.replace(0, np.nan))
        df.loc[has_amt, "f_amount_ratio_mean"] = a["amount"] / past_mean.replace(0, np.nan)
    df["f_log1p_amount"] = np.log1p(df["amount"])

    # 3b. Banking stateless transforms (mirror stateless_features exactly)
    bal_b = pd.to_numeric(df["balance_before"], errors="coerce")
    bal_a = pd.to_numeric(df["balance_after"], errors="coerce")
    amt = pd.to_numeric(df["amount"], errors="coerce")
    is_credit = pd.to_numeric(df["is_credit"], errors="coerce")
    df["f_balance_drain_ratio"] = (bal_b - bal_a) / (bal_b + 1.0)
    df["f_amount_vs_balance"] = amt / (bal_b + 1.0)
    signed = np.where(is_credit == 1.0, amt, -amt)
    df["f_balance_inconsistent"] = np.where(
        bal_b.isna() | bal_a.isna() | amt.isna(), np.nan,
        (np.abs((bal_b + signed) - bal_a) > 0.01).astype("float64"))

    p1 = np.radians(pd.to_numeric(df["geo_lat"], errors="coerce").to_numpy())
    l1 = np.radians(pd.to_numeric(df["geo_lon"], errors="coerce").to_numpy())
    p2 = np.radians(pd.to_numeric(df["counterparty_lat"], errors="coerce").to_numpy())
    l2 = np.radians(pd.to_numeric(df["counterparty_lon"], errors="coerce").to_numpy())
    hav = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin((l2 - l1) / 2) ** 2
    df["f_geo_distance_km"] = 2 * _EARTH_R_KM * np.arcsin(np.sqrt(hav))

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
