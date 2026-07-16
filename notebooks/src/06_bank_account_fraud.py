# %% [markdown]
# # Bank Account Fraud (BAF, NeurIPS 2022) — Account-Opening Fraud
#
# | | |
# |---|---|
# | **Source** | Kaggle `sgpjesus/bank-account-fraud-dataset-neurips-2022` |
# | **Origin** | Feedzai + academic (Jesus et al., NeurIPS 2022 Datasets track) — privacy-preserving synthesis of real bank data |
# | **License** | CC BY-NC-SA 4.0 |
# | **Samples** | 1,000,000 applications per variant (Base used here), 8 months |
# | **Features** | 30 income/velocity/device/session features |
# | **Labels** | `fraud_bool` (~1.1% fraud) |
# | **Caveats** | Monthly granularity only → synthetic within-month times (flagged). NC license: research only. |
# | **Production research suitability** | HIGH — modern, realistic, built for fraud-ML benchmarking with fairness metadata. |

# %%
import sys, glob
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import RAW, to_unified, dataset_report, numeric_summary, save_clean, save_unified_part

D = RAW / "financial" / "bank_account_fraud"

# %%
base = glob.glob(str(D / "**" / "Base.csv"), recursive=True)[0]
df = pd.read_csv(base)
print(df.shape)
df.head(3)

# %% [markdown]
# ## Cleaning
# BAF encodes missing values as negative sentinels in specific columns (per paper):
# `prev_address_months_count`, `current_address_months_count`, `intended_balcon_amount`,
# `bank_months_count`, `session_length_in_minutes`, `device_distinct_emails_8w` use -1 (or <0).

# %%
before = len(df)
df = df.drop_duplicates().reset_index(drop=True)
print(f"dropped {before - len(df)} duplicates")
sentinel_cols = ["prev_address_months_count", "current_address_months_count",
                 "intended_balcon_amount", "bank_months_count",
                 "session_length_in_minutes", "device_distinct_emails_8w"]
for c in sentinel_cols:
    n = int((df[c] < 0).sum())
    if n:
        df[f"{c}_missing"] = (df[c] < 0).astype("int8")
        df.loc[df[c] < 0, c] = np.nan
        print(f"{c}: {n} sentinel-missing -> NaN + indicator")

# %%
for c in ["payment_type", "employment_status", "housing_status", "source", "device_os"]:
    df[c] = df[c].astype("category")
assert df["fraud_bool"].isin([0, 1]).all()
df["fraud_bool"].value_counts(normalize=True)

# %% [markdown]
# ## Timestamp normalization
# Only `month` (0-7). Anchor 8-month window at 2022-01-01, uniform within month, flagged.

# %%
rng = np.random.default_rng(42)
anchor = pd.Timestamp("2022-01-01", tz="UTC")
df["event_time"] = (anchor + pd.to_timedelta(df["month"] * 30, unit="D")
                    + pd.to_timedelta(rng.uniform(0, 30 * 86400, len(df)), unit="s"))
df = df.sort_values("event_time").reset_index(drop=True)

# %% [markdown]
# ## EDA

# %%
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 3, figsize=(15, 4))
df.groupby("month")["fraud_bool"].mean().plot.bar(ax=axes[0], title="fraud rate by month")
df.groupby("device_os", observed=True)["fraud_bool"].mean().plot.bar(ax=axes[1], title="fraud rate by device OS")
axes[2].hist(df["credit_risk_score"].dropna(), bins=60); axes[2].set_title("credit_risk_score")
plt.tight_layout(); plt.savefig("../reports/baf_eda.png", dpi=110); plt.show()

# %%
numeric_summary(df, "bank_account_fraud").head(12)

# %% [markdown]
# ## Save clean + unified

# %%
save_clean(df, "bank_account_fraud")
dataset_report(df, "bank_account_fraud", label_col="fraud_bool",
               notes="Sentinel -1 -> NaN + indicators; month -> synthetic timestamps anchored 2022-01.")

# %%
u = pd.DataFrame({
    "event_time": df["event_time"],
    "event_subtype": "application",
    "amount": df["proposed_credit_limit"],
    "duration_s": df["session_length_in_minutes"] * 60,
    "severity": np.where(df["fraud_bool"] == 1, 3, 0).astype("int8"),
    "label": df["fraud_bool"].astype("Int8"),
    "time_is_synthetic": True,
})
attr_cols = ["income", "customer_age", "employment_status", "payment_type", "housing_status",
             "credit_risk_score", "velocity_6h", "velocity_24h", "velocity_4w",
             "device_os", "email_is_free", "foreign_request", "keep_alive_session",
             "phone_home_valid", "phone_mobile_valid", "month"]
u[attr_cols] = df[attr_cols]
u = to_unified(u, source_dataset="baf", event_domain="financial",
               event_type="account_open", label_type="fraud", attributes_cols=attr_cols)
save_unified_part(u, "baf")
u.head(3)
