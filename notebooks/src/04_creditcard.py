# %% [markdown]
# # ULB Credit Card Fraud — Card Transactions
#
# | | |
# |---|---|
# | **Source** | Kaggle `mlg-ulb/creditcardfraud` |
# | **Origin** | ULB Machine Learning Group / Worldline — real European card transactions, Sept 2013 |
# | **License** | DbCL v1.0 (Database Contents License) |
# | **Samples** | 284,807 transactions, 492 frauds (0.172%) |
# | **Features** | `Time` (sec since first txn), `V1..V28` (PCA-anonymized), `Amount` |
# | **Labels** | `Class` (1 = fraud) |
# | **Caveats** | PCA anonymization → features not human-interpretable; 2-day window only. |
# | **Production research suitability** | HIGH for fraud-model benchmarking; extreme class imbalance is realistic. |

# %%
import sys
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import RAW, to_unified, dataset_report, numeric_summary, iqr_outlier_share, save_clean, save_unified_part

D = RAW / "financial" / "creditcard"

# %%
df = pd.read_csv(D / "creditcard.csv")
print(df.shape)
df.head(3)

# %% [markdown]
# ## Cleaning

# %%
before = len(df)
df = df.drop_duplicates().reset_index(drop=True)
print(f"dropped {before - len(df)} exact duplicates")
print("missing:", int(df.isna().sum().sum()))
assert df["Class"].isin([0, 1]).all()
df["Class"].value_counts()

# %% [markdown]
# ## Timestamp normalization
# `Time` = seconds since first transaction; capture began 2013-09-01 (per dataset
# description: two days in September 2013). Anchor there — order-preserving, near-real.

# %%
anchor = pd.Timestamp("2013-09-01 00:00:00", tz="UTC")
df["event_time"] = anchor + pd.to_timedelta(df["Time"], unit="s")
df = df.sort_values("event_time").reset_index(drop=True)
df["event_time"].agg(["min", "max"])

# %% [markdown]
# ## Outliers + scaling
# `Amount` heavy-tailed → keep raw + log1p. V-features already PCA-scaled.

# %%
print("Amount outlier share (IQR):", round(iqr_outlier_share(df["Amount"]), 4))
df["log1p_amount"] = np.log1p(df["Amount"])
df["hour_of_day"] = df["event_time"].dt.hour

# %% [markdown]
# ## EDA

# %%
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 3, figsize=(15, 4))
axes[0].hist(df["log1p_amount"], bins=60); axes[0].set_title("log1p(Amount)")
df.groupby("hour_of_day")["Class"].mean().plot(ax=axes[1], title="fraud rate by hour")
df["Class"].value_counts().plot.bar(ax=axes[2], title="class balance (log)"); axes[2].set_yscale("log")
plt.tight_layout(); plt.savefig("../reports/creditcard_eda.png", dpi=110); plt.show()

# %%
numeric_summary(df, "creditcard").loc[["Time", "Amount", "V1", "V2", "V3"]]

# %% [markdown]
# ## Save clean + unified

# %%
save_clean(df, "creditcard")
dataset_report(df, "creditcard", label_col="Class",
               notes="PCA-anonymized; Time anchored to 2013-09-01 UTC (documented capture window).")

# %%
u = pd.DataFrame({
    "event_time": df["event_time"],
    "amount": df["Amount"],
    "severity": np.where(df["Class"] == 1, 3, 0).astype("int8"),
    "label": df["Class"].astype("Int8"),
    "time_is_synthetic": False,
})
attr_cols = [f"V{i}" for i in range(1, 29)]
u[attr_cols] = df[attr_cols].round(6)
u = to_unified(u, source_dataset="creditcard", event_domain="financial",
               event_type="card_txn", label_type="fraud", attributes_cols=attr_cols)
save_unified_part(u, "creditcard")
u.head(3)
