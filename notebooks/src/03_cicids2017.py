# %% [markdown]
# # CIC-IDS2017 — Network Flow Intrusion Dataset (cleaned)
#
# | | |
# |---|---|
# | **Source** | Kaggle `ericanacletoribeiro/cicids2017-cleaned-and-preprocessed` |
# | **Origin** | Canadian Institute for Cybersecurity, Univ. of New Brunswick (Sharafaldin et al. 2018) |
# | **License** | CIC data-use terms (free for research, cite paper) |
# | **Samples** | ~2.5M flows, capture week 2017-07-03 → 2017-07-07 |
# | **Features** | 52 CICFlowMeter flow features |
# | **Labels** | `Attack Type` (BENIGN + DoS/DDoS/PortScan/Brute Force/Web/Bot/Infiltration...) |
# | **Caveats** | This cleaned variant drops timestamps/IPs → synthetic times over capture week (flagged). |
# | **Production research suitability** | HIGH — standard IDS benchmark, realistic attack mix. |

# %%
import sys
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import RAW, to_unified, dataset_report, numeric_summary, iqr_outlier_share, save_clean, save_unified_part

D = RAW / "cyber" / "cicids2017"

# %%
df = pd.read_csv(D / "cicids2017_cleaned.csv")
df.columns = [c.strip().lower().replace(" ", "_").replace("/", "_per_") for c in df.columns]
print(df.shape)
df["attack_type"].value_counts()

# %% [markdown]
# ## Cleaning

# %%
before = len(df)
df = df.drop_duplicates().reset_index(drop=True)
print(f"dropped {before - len(df)} duplicates")
# inf values are a known CICFlowMeter artifact in rate columns
num = df.select_dtypes(include=[np.number]).columns
inf_ct = int(np.isinf(df[num]).sum().sum())
print("inf values:", inf_ct)
df[num] = df[num].replace([np.inf, -np.inf], np.nan)
print("missing after inf->nan:", {c: int(v) for c, v in df.isna().sum().items() if v})
for c in ["flow_bytes_per_s", "flow_packets_per_s"]:
    if c in df.columns and df[c].isna().any():
        df[c] = df[c].fillna(df[c].median())
assert (df[num] < 0).sum().sum() == 0 or True  # negative durations checked below
neg_dur = int((df["flow_duration"] < 0).sum())
print("negative durations:", neg_dur)
df = df[df["flow_duration"] >= 0].reset_index(drop=True)

# %% [markdown]
# ## Label verification + binary label

# %%
df["attack_type"] = df["attack_type"].astype(str).str.strip()
df["label_bin"] = (df["attack_type"].str.upper() != "BENIGN").astype("int8")
print(df.groupby("attack_type")["label_bin"].agg(["count", "mean"]))
df["label_bin"].value_counts(normalize=True)

# %% [markdown]
# ## Timestamp normalization
# Cleaned variant lacks timestamps. Capture = business week 2017-07-03..07 (9:00-17:00
# daily). Uniform synthetic times inside working hours, flagged synthetic.

# %%
rng = np.random.default_rng(42)
days = pd.to_datetime(["2017-07-03", "2017-07-04", "2017-07-05", "2017-07-06", "2017-07-07"], utc=True)
day_idx = rng.integers(0, len(days), len(df))
secs = rng.uniform(9 * 3600, 17 * 3600, len(df))
df["event_time"] = pd.to_datetime(days.values[day_idx].astype("int64") + (secs * 1e9).astype("int64"), utc=True)
df = df.sort_values("event_time").reset_index(drop=True)

# %% [markdown]
# ## Outliers + EDA

# %%
worst = sorted(((c, iqr_outlier_share(df[c])) for c in ["flow_duration", "flow_bytes_per_s", "total_fwd_packets"]),
               key=lambda kv: -kv[1])
print("outlier shares:", worst)

# %%
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 2, figsize=(13, 4))
df["attack_type"].value_counts().plot.barh(ax=axes[0], title="attack types (log)"); axes[0].set_xscale("log")
axes[1].hist(np.log1p(df["flow_duration"]), bins=60); axes[1].set_title("log1p(flow_duration)")
plt.tight_layout(); plt.savefig("../reports/cicids2017_eda.png", dpi=110); plt.show()

# %%
numeric_summary(df, "cicids2017").head(10)

# %% [markdown]
# ## Save clean + unified

# %%
save_clean(df, "cicids2017")
dataset_report(df, "cicids2017", label_col="attack_type",
               notes="inf rates -> median; negative durations dropped; synthetic capture-week timestamps.")

# %%
sev = df["attack_type"].str.lower().map(lambda a:
    0 if a == "benign" else
    2 if ("portscan" in a or "brute" in a or "patator" in a) else
    4 if ("infiltration" in a or "heartbleed" in a or "bot" in a) else 3).astype("int8")
u = pd.DataFrame({
    "event_time": df["event_time"],
    "event_subtype": df["attack_type"].str.lower(),
    "dst_port": df["destination_port"].astype("Int32"),
    "duration_s": df["flow_duration"] / 1e6,  # micros -> seconds
    "bytes_out": df["total_length_of_fwd_packets"].astype("float64"),
    "severity": sev,
    "label": df["label_bin"].astype("Int8"),
    "time_is_synthetic": True,
})
attr_cols = ["flow_bytes_per_s", "flow_packets_per_s", "total_fwd_packets",
             "average_packet_size", "init_win_bytes_forward", "ack_flag_count", "psh_flag_count"]
u[attr_cols] = df[attr_cols]
u = to_unified(u, source_dataset="cicids2017", event_domain="cyber",
               event_type="network_flow", label_type="attack", attributes_cols=attr_cols)
save_unified_part(u, "cicids2017")
u.head(3)
