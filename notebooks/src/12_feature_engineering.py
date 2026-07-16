# %% [markdown]
# # Feature Engineering — Compact Training Corpus
#
# Input: `unified_events_compact.parquet` (training corpus sized for a <1 GB VRAM
# deployment target). All features interpretable by construction. Groups:
#
# 1. **Temporal** — hour, day-of-week, weekend/night flags, cyclical encodings
# 2. **Behavioural (per user)** — sequence number, time since last event,
#    past malicious rate, new-country flag (impossible-travel proxy)
# 3. **Transactional** — amount z-score vs user's PAST history, ratio to past mean
# 4. **Cyber/volume** — log bytes, bytes ratio, device past high-severity count
#
# Leakage rule: every historical feature excludes the current row (cumulative
# sums shifted by construction: `cum - current`). Implemented with vectorized
# groupby-cumsum — no per-group Python loops.

# %%
import sys, json
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import UNIFIED, REPORTS

df = pd.read_parquet(UNIFIED / "unified_events_compact.parquet")
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
df["f_hour_sin"] = np.sin(2 * np.pi * df["f_hour"] / 24)
df["f_hour_cos"] = np.cos(2 * np.pi * df["f_hour"] / 24)

# %% [markdown]
# ## 2. Behavioural per-user (past-only, vectorized)

# %%
has_user = df["user_id"].notna()
sub = df.loc[has_user]
g = sub.groupby("user_id", observed=True, sort=False)

seq = g.cumcount()
df.loc[has_user, "f_user_seq_no"] = seq
df.loc[has_user, "f_user_secs_since_last"] = g["event_time"].diff().dt.total_seconds()

# past malicious rate = (cumulative positives - current) / prior event count
is_pos = sub["label"].eq(1).astype("float64")
cum_pos = is_pos.groupby(sub["user_id"], observed=True, sort=False).cumsum()
past_rate = (cum_pos - is_pos) / seq.replace(0, np.nan)
df.loc[has_user, "f_user_past_malicious_rate"] = past_rate

# new-country flag: first event of user from this country
has_uc = has_user & df["country"].notna()
uc = df.loc[has_uc]
df.loc[has_uc, "f_user_new_country"] = (
    uc.groupby(["user_id", "country"], observed=True, sort=False).cumcount().eq(0).astype("int8"))

# %% [markdown]
# ## 3. Transactional per-user (past-only, vectorized moments)

# %%
has_amt = has_user & df["amount"].notna()
a = df.loc[has_amt, ["user_id", "amount"]]
ga = a.groupby("user_id", observed=True, sort=False)["amount"]
n_prior = ga.cumcount()
cs = ga.cumsum() - a["amount"]                    # past sum
cs2 = (a["amount"] ** 2).groupby(a["user_id"], observed=True, sort=False).cumsum() - a["amount"] ** 2
past_mean = cs / n_prior.replace(0, np.nan)
past_var = (cs2 / n_prior.replace(0, np.nan)) - past_mean ** 2
past_std = np.sqrt(past_var.clip(lower=0))
df.loc[has_amt, "f_amount_z_user"] = (a["amount"] - past_mean) / past_std.replace(0, np.nan)
df.loc[has_amt, "f_amount_ratio_mean"] = a["amount"] / past_mean.replace(0, np.nan)
df["f_log1p_amount"] = np.log1p(df["amount"])

# %% [markdown]
# ## 4. Cyber / volume + device history (vectorized)

# %%
df["f_log1p_bytes_out"] = np.log1p(df["bytes_out"])
df["f_log1p_bytes_in"] = np.log1p(df["bytes_in"])
df["f_bytes_ratio"] = df["bytes_out"] / (df["bytes_in"] + 1)
has_dev = df["device_id"].notna()
d = df.loc[has_dev]
gd = d.groupby("device_id", observed=True, sort=False)
df.loc[has_dev, "f_device_seq_no"] = gd.cumcount()
hisev = d["severity"].ge(3).astype("float64")
cum_hisev = hisev.groupby(d["device_id"], observed=True, sort=False).cumsum()
df.loc[has_dev, "f_device_past_hisev_count"] = cum_hisev - hisev

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
    "f_amount_z_user": "Amount z-score vs user's PAST transactions (vectorized cumulative moments)",
    "f_amount_ratio_mean": "Amount / user's PAST mean amount",
    "f_log1p_amount": "log1p(amount)",
    "f_log1p_bytes_out": "log1p(bytes_out)",
    "f_log1p_bytes_in": "log1p(bytes_in)",
    "f_bytes_ratio": "bytes_out / (bytes_in + 1)",
    "f_device_seq_no": "Number of prior events on this device",
    "f_device_past_hisev_count": "Count of device's PAST severity>=3 events (leakage-safe)",
    "sampling_weight": "Inverse sampling probability of the row's stratum (benign caps in 11_unify); use as instance weight to recover population rates",
}
(REPORTS / "feature_documentation.json").write_text(json.dumps(feature_docs, indent=2))
fcols = [c for c in feature_docs if c in df.columns]
print(df[fcols].describe().T[["count", "mean", "std", "min", "max"]])
df.to_parquet(UNIFIED / "unified_events_engineered.parquet", index=False)
print("saved unified_events_engineered.parquet", df.shape)
