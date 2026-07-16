# %% [markdown]
# # UNSW-NB15 — Network Intrusion Flows
#
# | | |
# |---|---|
# | **Source** | Kaggle `dhoogla/unswnb15` (curated parquet of official UNSW-NB15 train/test split) |
# | **Origin** | ACCS, UNSW Canberra — Moustafa & Slay 2015 |
# | **License** | CC BY 4.0 (per Kaggle listing) |
# | **Samples** | 257,673 flows (175,341 train + 82,332 test) |
# | **Features** | 34 numeric/categorical flow features + `attack_cat` + `label` |
# | **Labels** | binary `label` + 9 attack categories + Normal |
# | **Caveats** | This curated version drops raw IPs/ports/timestamps; capture windows were 2015-01-22 and 2015-02-17. Synthetic timestamps assigned (flagged). |
# | **Production research suitability** | HIGH — widely benchmarked, labeled, realistic mixed traffic. Not toy. |

# %%
import sys, json
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import RAW, to_unified, dataset_report, numeric_summary, iqr_outlier_share, save_clean, save_unified_part

pd.set_option("display.max_columns", 50)
D = RAW / "cyber" / "unsw_nb15"

# %% [markdown]
# ## Load

# %%
train = pd.read_parquet(D / "UNSW_NB15_training-set.parquet")
test = pd.read_parquet(D / "UNSW_NB15_testing-set.parquet")
train["split"], test["split"] = "train", "test"
df = pd.concat([train, test], ignore_index=True)
print(df.shape)
df.head(3)

# %% [markdown]
# ## Cleaning — duplicates, missing, dtypes

# %%
before = len(df)
df = df.drop_duplicates(subset=[c for c in df.columns if c != "split"]).reset_index(drop=True)
print(f"dropped {before - len(df)} duplicate flows")
print("missing values:", int(df.isna().sum().sum()))

# %%
# categorical normalization
for c in ["proto", "service", "state", "attack_cat"]:
    df[c] = df[c].astype(str).str.strip().str.lower().astype("category")
df["service"] = df["service"].cat.rename_categories(lambda s: "unknown" if s == "-" else s)
df["attack_cat"].value_counts()

# %% [markdown]
# ## Label verification
# `label` must equal 1 exactly when `attack_cat != normal`.

# %%
mismatch = ((df["attack_cat"] != "normal") != (df["label"] == 1)).sum()
print("label/attack_cat mismatches:", mismatch)
assert mismatch == 0
df["label"].value_counts(normalize=True)

# %% [markdown]
# ## Timestamp normalization
# Curated version has no raw timestamps. Capture ran in two windows
# (2015-01-22, 2015-02-17; 16h each per dataset paper). Assign uniform synthetic
# times inside those windows, preserving nothing temporal — flag `time_is_synthetic`.

# %%
rng = np.random.default_rng(42)
w1 = pd.Timestamp("2015-01-22 00:00:00", tz="UTC")
w2 = pd.Timestamp("2015-02-17 00:00:00", tz="UTC")
half = len(df) // 2
offs = rng.uniform(0, 16 * 3600, len(df))
starts = np.where(np.arange(len(df)) < half, w1.value, w2.value)
df["event_time"] = pd.to_datetime(starts + (offs * 1e9).astype("int64"), utc=True)
df = df.sort_values("event_time").reset_index(drop=True)

# %% [markdown]
# ## Outlier inspection + numeric normalization
# Flow features are heavy-tailed. Keep raw values in clean output (models decide
# scaling); record outlier shares + store log1p variants for the worst columns.

# %%
num_cols = df.select_dtypes(include=[np.number]).columns.drop(["label"])
out_share = {c: iqr_outlier_share(df[c]) for c in num_cols}
worst = sorted(out_share.items(), key=lambda kv: -kv[1])[:10]
print("worst IQR outlier shares:", worst)
for c in ["sbytes", "dbytes", "sload", "dload", "dur"]:
    df[f"log1p_{c}"] = np.log1p(df[c])

# %% [markdown]
# ## EDA

# %%
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 3, figsize=(15, 4))
df["attack_cat"].value_counts().plot.barh(ax=axes[0], title="attack categories")
df["proto"].value_counts().head(10).plot.barh(ax=axes[1], title="top protocols")
axes[2].hist(df["log1p_sbytes"], bins=60); axes[2].set_title("log1p(sbytes)")
plt.tight_layout(); plt.savefig("../reports/unsw_nb15_eda.png", dpi=110); plt.show()

# %%
numeric_summary(df, "unsw_nb15").head(15)

# %% [markdown]
# ## Save clean + map to unified schema

# %%
save_clean(df, "unsw_nb15")
rep = dataset_report(df, "unsw_nb15", label_col="label",
                     notes="Curated parquet; no raw IP/timestamp; synthetic event_time flagged.")

# %%
sev_map = {"normal": 0, "analysis": 2, "reconnaissance": 2, "fuzzers": 2,
           "dos": 3, "generic": 3, "exploits": 3,
           "backdoor": 4, "shellcode": 4, "worms": 4}
u = pd.DataFrame({
    "event_time": df["event_time"],
    "event_subtype": df["attack_cat"].astype(str),
    "protocol": df["proto"].astype(str),
    "duration_s": df["dur"],
    "bytes_out": df["sbytes"].astype("float64"),
    "bytes_in": df["dbytes"].astype("float64"),
    "severity": df["attack_cat"].astype(str).map(sev_map).astype("Int8"),
    "label": df["label"].astype("Int8"),
    "time_is_synthetic": True,
})
attr_cols = ["service", "state", "rate", "sload", "dload", "spkts", "dpkts", "tcprtt", "split"]
u[attr_cols] = df[attr_cols]
u = to_unified(u, source_dataset="unsw_nb15", event_domain="cyber",
               event_type="network_flow", label_type="attack", attributes_cols=attr_cols)
save_unified_part(u, "unsw_nb15")
u.head(3)
