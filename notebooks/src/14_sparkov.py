# %% [markdown]
# # Sparkov — Simulated Card Transactions with Real Customer Sequences
#
# | | |
# |---|---|
# | **Source** | Kaggle `kartik2112/fraud-detection` |
# | **Origin** | Generated with [Sparkov Data Generation](https://github.com/namebrandon/Sparkov_Data_Generation) (Brandon Harris), profile-driven agent simulation |
# | **License** | **CC0-1.0** — public domain, unrestricted commercial use |
# | **Samples** | 1,852,394 transactions, 999 cards, 693 merchants, 2019-01-01 → 2020-12-31 |
# | **Labels** | `is_fraud` (0.521%) |
# | **Caveats** | Merchant coordinates are drawn independently of the label → geo-distance carries **no** fraud signal here. `fraud_` prefixes every merchant name (naming artifact, not a leak). |
# | **Production research suitability** | **HIGH — and unique in this corpus.** Median **1,471** transactions per card over 24 months. |
#
# ## Why this dataset was added
#
# The fraud model's history features (`f_user_seq_no`, `f_user_secs_since_last`,
# `f_amount_z_user`, `f_amount_ratio_mean`) were **completely dead**: measured on the v1
# corpus, 0% of fraud training rows had any user history, and all four features had a
# mean |SHAP| of exactly 0.0. No financial source supplied usable per-customer sequences —
# PaySim has 158,262 distinct `nameOrig` across 158,265 sampled rows (1.0 txn/user), and
# creditcard/BAF have no entity key at all.
#
# Sparkov is the only public source in the corpus that can teach velocity and
# amount-vs-history. That is the entire reason it is here.

# %%
import sys
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import RAW, to_unified, dataset_report, numeric_summary, save_clean, save_unified_part

D = RAW / "financial" / "sparkov"

# %%
# The Kaggle split is a plain chronological cut of one simulation run; the unify
# stage re-splits per-source temporally, so recombine and let it own the split.
df = pd.concat([pd.read_csv(D / f, low_memory=False) for f in ("fraudTrain.csv", "fraudTest.csv")],
               ignore_index=True)
df = df.drop(columns=[c for c in df.columns if c.startswith("Unnamed")])
print(df.shape)
df.head(3)

# %% [markdown]
# ## Cleaning + consistency checks

# %%
before = len(df)
df = df.drop_duplicates(subset=["trans_num"]).reset_index(drop=True)
print(f"dropped {before - len(df)} duplicate trans_num; missing: {int(df.isna().sum().sum())}")
assert df["is_fraud"].isin([0, 1]).all()
assert df["trans_num"].is_unique
df["trans_date_trans_time"] = pd.to_datetime(df["trans_date_trans_time"], utc=True)
df["dob"] = pd.to_datetime(df["dob"], errors="coerce")
df = df.sort_values(["trans_date_trans_time", "trans_num"]).reset_index(drop=True)
print("fraud rate:", round(float(df["is_fraud"].mean()), 5))

# %% [markdown]
# ## Non-leak check: the `fraud_` merchant prefix
#
# Every merchant name is prefixed `fraud_` — including those of purely benign
# transactions. It is an artifact of the generator, **not** a target leak. Asserted
# rather than commented, so a future dataset revision cannot silently break it.

# %%
prefix_share = float(df["merchant"].str.startswith("fraud_").mean())
print("merchants prefixed 'fraud_':", prefix_share)
assert prefix_share == 1.0, "prefix no longer universal — re-check for label leakage"
df["merchant"] = df["merchant"].str.removeprefix("fraud_")

# %% [markdown]
# ## Sequence density — the property we bought this dataset for

# %%
tpc = df.groupby("cc_num").size()
print(f"cards: {df['cc_num'].nunique()}   merchants: {df['merchant'].nunique()}")
print(f"txns/card: min={tpc.min()} p25={tpc.quantile(.25):.0f} median={tpc.median():.0f} "
      f"p75={tpc.quantile(.75):.0f} max={tpc.max()}")
print(f"cards with >=100 txns: {int((tpc >= 100).sum())} / {len(tpc)}")
assert tpc.median() >= 100, "sequence density collapsed — history features would go dead again"

# %% [markdown]
# ## Derived canonical fields
#
# `channel` comes from the category suffix (`_net` → web, `_pos` → pos): a real,
# bank-servable signal. `customer_age` is computed at transaction time, not from a
# static column, so it ages correctly across the 24-month window.

# %%
df["channel"] = np.where(df["category"].str.endswith("_net"), "web",
                         np.where(df["category"].str.endswith("_pos"), "pos", "web"))
df["customer_age"] = ((df["trans_date_trans_time"].dt.tz_localize(None) - df["dob"])
                      .dt.days / 365.25).round(2)

# Great-circle km, customer home → merchant. Retained for schema completeness and
# for the simulator, which DOES model it; measured spread here is 76.1 vs 76.3 km
# (benign vs fraud) i.e. no signal. Documented in docs/canonical_schema.md so the
# feature's weakness is never mistaken for a bug.
_R = 6371.0
_la1, _lo1, _la2, _lo2 = (np.radians(df[c].to_numpy())
                          for c in ("lat", "long", "merch_lat", "merch_long"))
df["geo_distance_km"] = (2 * _R * np.arcsin(np.sqrt(
    np.sin((_la2 - _la1) / 2) ** 2
    + np.cos(_la1) * np.cos(_la2) * np.sin((_lo2 - _lo1) / 2) ** 2))).round(3)
print(df.groupby("is_fraud")["geo_distance_km"].mean().round(1).to_string())

# %% [markdown]
# ## EDA

# %%
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 3, figsize=(15, 4))
df.groupby("category")["is_fraud"].mean().sort_values().plot.barh(
    ax=axes[0], title="fraud rate by category")
df.groupby(df["trans_date_trans_time"].dt.hour)["is_fraud"].mean().plot(
    ax=axes[1], title="fraud rate by hour (UTC)")
axes[2].hist(np.log1p(df.loc[df.is_fraud == 0, "amt"]), bins=60, alpha=.6, label="benign", density=True)
axes[2].hist(np.log1p(df.loc[df.is_fraud == 1, "amt"]), bins=60, alpha=.6, label="fraud", density=True)
axes[2].set_title("log1p(amt)"); axes[2].legend()
plt.tight_layout(); plt.savefig("../reports/sparkov_eda.png", dpi=110); plt.show()

# %%
numeric_summary(df, "sparkov").loc[["amt", "customer_age", "city_pop", "geo_distance_km"]]

# %% [markdown]
# ## Save clean + unified

# %%
save_clean(df, "sparkov")
dataset_report(df, "sparkov", label_col="is_fraud",
               notes="CC0-1.0. Real per-card sequences (median 1471 txns/card) — the only "
                     "public financial source in this corpus with usable user history. "
                     "geo distance carries no fraud signal (76.1 vs 76.3 km).")

# %%
u = pd.DataFrame({
    "event_id": "sparkov-" + df["trans_num"],
    "event_time": df["trans_date_trans_time"],
    "event_subtype": "card_purchase",
    "user_id": df["cc_num"].astype(str),
    "amount": df["amt"],
    "country": "US",
    # v2 rule: severity is ex-ante triage, NEVER a function of label. The v1
    # loaders set `3 if fraud else 0`, which leaked into f_device_past_hisev_count.
    "severity": np.int8(0),
    "label": df["is_fraud"].astype("Int8"),
    "time_is_synthetic": False,
    # --- canonical banking block ---
    "counterparty_id": df["merchant"],
    "counterparty_country": "US",
    "counterparty_lat": df["merch_lat"],
    "counterparty_lon": df["merch_long"],
    "merchant_id": df["merchant"],
    "merchant_category": df["category"],
    "geo_lat": df["lat"],
    "geo_lon": df["long"],
    "customer_age": df["customer_age"],
    "channel": df["channel"],
    "currency": "USD",
    "payment_type": "card_purchase",
    "is_credit": np.int8(0),
})
# Source-local: PII and US-census detail no bank would send to a scoring API.
attr_cols = ["first", "last", "gender", "street", "city", "state", "zip", "job",
             "city_pop", "dob", "geo_distance_km", "unix_time"]
u[attr_cols] = df[attr_cols]
u = to_unified(u, source_dataset="sparkov", event_domain="financial",
               event_type="card_txn", label_type="fraud", attributes_cols=attr_cols)
save_unified_part(u, "sparkov")
u.head(3)
