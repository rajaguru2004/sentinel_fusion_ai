# %% [markdown]
# # Feature Engineering — Compact Training Corpus
#
# Input: `unified_events_compact.parquet`. Output: the engineered corpus the
# models train on.
#
# ## This notebook no longer implements the features
#
# It used to. That was the problem: the same feature maths existed in three
# places that had to be kept in sync by hand —
#
# 1. this notebook (offline training corpus),
# 2. `ml/feature_core.py::engineer_batch` (offline reference / batch scoring),
# 3. `ml/feature_core.py`'s incremental `user_features`/`advance_user` (serving).
#
# Nothing enforced that they agreed, so "training and serving share a feature
# contract" was a convention rather than a guarantee. Now there is **one**
# declaration (`ml/feature_spec.py`) and **one** offline implementation
# (`engineer_batch`), which `tests/unit/test_feature_parity.py` proves equal to
# the incremental serving path. This notebook just calls it.
#
# Leakage rule (unchanged): every historical feature is past-only — cumulative
# sums shifted by construction (`cum - current`).

# %%
import sys
sys.path.insert(0, "..")
import json
import pandas as pd
from prep_utils import UNIFIED, REPORTS

sys.path.insert(0, "../..")
from ml.feature_core import ENGINEERED_F, engineer_batch
from ml.feature_spec import CONTRACT_HASH, TXN_WINDOW_S

df = pd.read_parquet(UNIFIED / "unified_events_compact.parquet")
df = df.sort_values(["event_time", "event_id"]).reset_index(drop=True)
print(f"{len(df):,} rows x {df.shape[1]} cols   contract={CONTRACT_HASH}")

# %% [markdown]
# ## Engineer (single shared implementation)

# %%
df = engineer_batch(df)
print(f"engineered {len(ENGINEERED_F)} features")

# %% [markdown]
# ## Coverage check — the regression that killed v1
#
# In v1 every fraud training row had `f_user_seq_no` = 0/NaN because row-level
# sampling had shattered per-customer sequences (PaySim: 158,262 users across
# 158,265 rows). All four history features scored mean |SHAP| = 0.0. Assert the
# coverage here so the corpus cannot silently regress to that state again.

# %%
fin = df[df["event_domain"] == "financial"]
cov = pd.DataFrame({
    "notnull": df.groupby("source_dataset", observed=True)["f_user_seq_no"].apply(
        lambda s: s.notna().mean()).round(3),
    "seq_gt0": df.groupby("source_dataset", observed=True)["f_user_seq_no"].apply(
        lambda s: (s > 0).mean()).round(3),
    "velocity_gt0": df.groupby("source_dataset", observed=True)["f_user_txn_count_1h"].apply(
        lambda s: (s > 0).mean()).round(3),
})
print(cov.to_string())

share = float((fin["f_user_seq_no"] > 0).mean())
print(f"\nfinancial rows with user history: {share:.1%}")
assert share >= 0.40, (
    f"only {share:.1%} of financial rows carry user history -- the v1 regression "
    "has returned; check NO_SAMPLE in 11_unify.py")

# %% [markdown]
# ## Persist + feature documentation

# %%
feature_docs = {
    "f_hour": "Hour of event (0-23, UTC)",
    "f_dayofweek": "Day of week (0=Mon)",
    "f_is_weekend": "1 if Sat/Sun",
    "f_is_night": "1 if 00:00-05:59 UTC",
    "f_hour_sin": "sin(2*pi*hour/24) cyclical encoding",
    "f_hour_cos": "cos(2*pi*hour/24) cyclical encoding",
    "f_user_seq_no": "Number of prior events by this user (0-based)",
    "f_user_secs_since_last": "Seconds since user's previous event",
    "f_user_past_malicious_rate": "Share of user's PAST events labeled 1 (excludes current row; leakage-safe)",
    "f_user_new_country": "1 if first event of this user from this country (impossible-travel proxy)",
    "f_amount_z_user": "Amount z-score vs user's PAST transactions; NaN when past spread is ~0",
    "f_amount_ratio_mean": "Amount / user's PAST mean amount",
    "f_log1p_amount": "log1p(amount)",
    "f_log1p_bytes_out": "log1p(bytes_out)",
    "f_log1p_bytes_in": "log1p(bytes_in)",
    "f_bytes_ratio": "bytes_out / (bytes_in + 1)",
    "f_device_seq_no": "Number of prior events on this device",
    "f_device_past_hisev_count": "Count of device's PAST severity>=3 events. NOTE: severity was label-derived in v1, so this leaks; retained only for the frozen cyber/quantum models",
    "f_balance_drain_ratio": "(balance_before - balance_after) / (balance_before + 1); ~1.0 = drain-to-zero",
    "f_amount_vs_balance": "amount / (balance_before + 1)",
    "f_balance_inconsistent": "1 if balance_after != balance_before +/- amount (direction from is_credit)",
    "f_geo_distance_km": "Great-circle km, actor -> counterparty. NOTE: no fraud signal in sparkov (76.1 vs 76.3 km); simulator-only",
    "f_counterparty_new": "1 if first payment by this user to this counterparty (model-side isNewBeneficiary)",
    "f_user_distinct_counterparties": "Distinct counterparties this user paid BEFORE this event",
    "f_merchant_category_novel": "1 if first event of this user in this merchant category",
    "f_user_txn_count_1h": f"User's events in the previous {TXN_WINDOW_S}s, excluding this one",
    "sampling_weight": "Inverse sampling probability of the row's stratum (11_unify); use as instance weight to recover population rates. 1.0 for un-sampled sequence-preserving sources",
}
(REPORTS / "feature_documentation.json").write_text(json.dumps(feature_docs, indent=2))
fcols = [c for c in feature_docs if c in df.columns]
print(df[fcols].describe().T[["count", "mean", "std", "min", "max"]].to_string())
df.to_parquet(UNIFIED / "unified_events_engineered.parquet", index=False)
print("saved unified_events_engineered.parquet", df.shape)
