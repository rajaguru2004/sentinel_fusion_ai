# %% [markdown]
# # Feature Engineering — Unified Events
#
# All features interpretable by construction. Groups:
#
# 1. **Temporal** — hour, day-of-week, weekend/night flags, inter-event gaps
# 2. **Behavioural (per user)** — event counts in rolling windows, time since last
#    event, new-country flag (impossible-travel proxy), historical malicious rate
# 3. **Transactional** — amount z-score vs user history, ratio to user median
# 4. **Cyber/volume** — log bytes, bytes ratio, high-severity rolling counts per device
#
# Leakage rule: every rolling/historical feature uses only PAST events
# (shift(1) before cumulative ops). Label never enters its own row's features.

# %%
import sys, json
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import UNIFIED, REPORTS

df = pd.read_parquet(UNIFIED / "unified_events.parquet")
df = df.sort_values(["event_time", "event_id"]).reset_index(drop=True)
print(df.shape)

# %% [markdown]
# ## 1. Temporal

# %%
t = df["event_time"]
df["f_hour"] = t.dt.hour.astype("int8")
df["f_dayofweek"] = t.dt.dayofweek.astype("int8")
df["f_is_weekend"] = (df["f_dayofweek"] >= 5).astype("int8")
df["f_is_night"] = df["f_hour"].isin([0, 1, 2, 3, 4, 5]).astype("int8")
# cyclical encodings keep interpretability (documented mapping)
df["f_hour_sin"] = np.sin(2 * np.pi * df["f_hour"] / 24)
df["f_hour_cos"] = np.cos(2 * np.pi * df["f_hour"] / 24)

# %% [markdown]
# ## 2. Behavioural per-user (past-only)

# %%
has_user = df["user_id"].notna()
g = df.loc[has_user].groupby("user_id", observed=True)
df.loc[has_user, "f_user_seq_no"] = g.cumcount()
df.loc[has_user, "f_user_secs_since_last"] = (
    g["event_time"].diff().dt.total_seconds())
# past malicious rate: shift(1) then expanding mean — excludes current row
past_mal = (g["label"].apply(lambda s: s.eq(1).shift(1).expanding().mean())
            .reset_index(level=0, drop=True))
df.loc[has_user, "f_user_past_malicious_rate"] = past_mal
# new-country flag (impossible-travel proxy): first time user seen from this country
has_uc = has_user & df["country"].notna()
seen = df.loc[has_uc].groupby(["user_id", "country"], observed=True).cumcount()
df.loc[has_uc, "f_user_new_country"] = (seen == 0).astype("int8")

# %% [markdown]
# ## 3. Transactional per-user (past-only)

# %%
has_amt = has_user & df["amount"].notna()
ga = df.loc[has_amt].groupby("user_id", observed=True)["amount"]
past_mean = ga.apply(lambda s: s.shift(1).expanding().mean()).reset_index(level=0, drop=True)
past_std = ga.apply(lambda s: s.shift(1).expanding().std()).reset_index(level=0, drop=True)
past_med = ga.apply(lambda s: s.shift(1).expanding().median()).reset_index(level=0, drop=True)
df.loc[has_amt, "f_amount_z_user"] = ((df.loc[has_amt, "amount"] - past_mean) / past_std.replace(0, np.nan))
df.loc[has_amt, "f_amount_ratio_median"] = df.loc[has_amt, "amount"] / past_med.replace(0, np.nan)
df["f_log1p_amount"] = np.log1p(df["amount"])

# %% [markdown]
# ## 4. Cyber / volume + device history

# %%
df["f_log1p_bytes_out"] = np.log1p(df["bytes_out"])
df["f_log1p_bytes_in"] = np.log1p(df["bytes_in"])
df["f_bytes_ratio"] = df["bytes_out"] / (df["bytes_in"] + 1)
has_dev = df["device_id"].notna()
gd = df.loc[has_dev].groupby("device_id", observed=True)
df.loc[has_dev, "f_device_seq_no"] = gd.cumcount()
past_hisev = (gd["severity"].apply(lambda s: s.ge(3).shift(1).expanding().sum())
              .reset_index(level=0, drop=True))
df.loc[has_dev, "f_device_past_hisev_count"] = past_hisev

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
    "f_user_past_malicious_rate": "Mean of user's PAST labels==1 (excludes current row; leakage-safe)",
    "f_user_new_country": "1 if first event of this user from this country (impossible-travel proxy)",
    "f_amount_z_user": "Amount z-score vs user's PAST transaction history",
    "f_amount_ratio_median": "Amount / user's PAST median amount",
    "f_log1p_amount": "log1p(amount)",
    "f_log1p_bytes_out": "log1p(bytes_out)",
    "f_log1p_bytes_in": "log1p(bytes_in)",
    "f_bytes_ratio": "bytes_out / (bytes_in + 1)",
    "f_device_seq_no": "Number of prior events on this device",
    "f_device_past_hisev_count": "Count of device's PAST severity>=3 events (leakage-safe)",
}
(REPORTS / "feature_documentation.json").write_text(json.dumps(feature_docs, indent=2))
fcols = list(feature_docs)
print(df[fcols].describe().T[["count", "mean", "std", "min", "max"]])
df.to_parquet(UNIFIED / "unified_events_engineered.parquet", index=False)
print("saved unified_events_engineered.parquet", df.shape)
