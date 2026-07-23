# %% [markdown]
# # PaySim — Mobile Money Transactions
#
# | | |
# |---|---|
# | **Source** | Kaggle `ealaxi/paysim1` |
# | **Origin** | Lopez-Rojas et al. — agent-based simulation calibrated on real African mobile-money logs |
# | **License** | CC BY-SA 4.0 |
# | **Samples** | 6,362,620 transactions over 744 simulated hours (30 days) |
# | **Features** | step, type, amount, orig/dest account IDs + balances |
# | **Labels** | `isFraud`, plus rule-based `isFlaggedFraud` |
# | **Caveats** | Synthetic but calibrated on real logs; fraud only in TRANSFER + CASH_OUT. |
# | **Production research suitability** | HIGH for transaction-sequence/behaviour modeling; account IDs enable per-customer history. |

# %%
import sys
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import RAW, to_unified, dataset_report, numeric_summary, save_clean, save_unified_part

D = RAW / "financial" / "paysim"

# %%
import glob
csv = glob.glob(str(D / "*.csv"))[0]
df = pd.read_csv(csv)
print(df.shape)
df.head(3)

# %% [markdown]
# ## Cleaning + consistency checks

# %%
before = len(df)
df = df.drop_duplicates().reset_index(drop=True)
print(f"dropped {before - len(df)} duplicates; missing: {int(df.isna().sum().sum())}")
df["type"] = df["type"].astype("category")
assert df["isFraud"].isin([0, 1]).all()
# balance-equation violations are a known PaySim artifact — measure, keep as feature
orig_err = (df["oldbalanceOrg"] - df["amount"] - df["newbalanceOrig"]).abs()
df["orig_balance_inconsistent"] = ((orig_err > 0.01) & (df["oldbalanceOrg"] > 0)).astype("int8")
print("orig balance inconsistency rate:", round(df["orig_balance_inconsistent"].mean(), 4))

# %% [markdown]
# ## Label verification
# Fraud must occur only in TRANSFER/CASH_OUT per dataset design.

# %%
print(df.groupby("type", observed=True)["isFraud"].sum())
assert df.loc[df["isFraud"] == 1, "type"].isin(["TRANSFER", "CASH_OUT"]).all()
df["isFraud"].value_counts(normalize=True)

# %% [markdown]
# ## Timestamp normalization
# `step` = 1 hour of simulation, 744 steps = 30 days. Anchor at 2023-01-01 UTC
# (synthetic, flagged). Random within-hour jitter keeps sequence but breaks ties.

# %%
rng = np.random.default_rng(42)
anchor = pd.Timestamp("2023-01-01 00:00:00", tz="UTC")
df["event_time"] = anchor + pd.to_timedelta(df["step"] - 1, unit="h") \
    + pd.to_timedelta(rng.uniform(0, 3600, len(df)), unit="s")
df = df.sort_values("event_time").reset_index(drop=True)

# %% [markdown]
# ## EDA

# %%
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 3, figsize=(15, 4))
df["type"].value_counts().plot.bar(ax=axes[0], title="txn types")
df.groupby(df["step"] // 24)["isFraud"].mean().plot(ax=axes[1], title="fraud rate by day")
axes[2].hist(np.log1p(df["amount"]), bins=60); axes[2].set_title("log1p(amount)")
plt.tight_layout(); plt.savefig("../reports/paysim_eda.png", dpi=110); plt.show()

# %%
numeric_summary(df, "paysim")

# %% [markdown]
# ## Save clean + unified

# %%
save_clean(df, "paysim")
dataset_report(df, "paysim", label_col="isFraud",
               notes="Simulated 30-day window anchored 2023-01-01 (synthetic). Balance inconsistencies kept as feature.")

# %%
_PAYMENT_TYPE = {"TRANSFER": "transfer", "CASH_OUT": "cash_out", "CASH_IN": "cash_in",
                 "DEBIT": "debit", "PAYMENT": "payment"}

u = pd.DataFrame({
    "event_time": df["event_time"],
    "event_subtype": df["type"].astype(str).str.lower(),
    "user_id": df["nameOrig"],
    "amount": df["amount"],
    # v2 rule: severity is ex-ante triage, NEVER a function of label. v1 set
    # `3 if isFraud else 0` -- a perfect target alias that leaked into the models
    # via f_device_past_hisev_count. See docs/canonical_schema.md.
    "severity": np.int8(0),
    "label": df["isFraud"].astype("Int8"),
    "time_is_synthetic": True,
    # --- canonical banking block (promoted out of `attributes`) ---
    # Balance movement is THE PaySim fraud pattern (accounts drained to zero) and
    # in v1 it was packed into the JSON blob that 11_unify.py then dropped, so no
    # model ever saw it.
    "balance_before": df["oldbalanceOrg"],
    "balance_after": df["newbalanceOrig"],
    "counterparty_balance_before": df["oldbalanceDest"],
    "counterparty_balance_after": df["newbalanceDest"],
    "counterparty_id": df["nameDest"],
    "payment_type": df["type"].astype(str).map(_PAYMENT_TYPE),
    "channel": "mobile",
    "is_credit": (df["type"].astype(str) == "CASH_IN").astype("Int8"),
})
# Source-local: simulator bookkeeping + the rule-engine's own flag (never a
# feature -- it is a verdict, not an observation). `orig_balance_inconsistent`
# stays here because it is now derivable at serving time from the canonical
# balance columns, so it becomes an f_* feature rather than a raw column.
attr_cols = ["isFlaggedFraud", "orig_balance_inconsistent", "step"]
u[attr_cols] = df[attr_cols]
u = to_unified(u, source_dataset="paysim", event_domain="financial",
               event_type="mobile_txn", label_type="fraud", attributes_cols=attr_cols)
save_unified_part(u, "paysim")
u.head(3)
