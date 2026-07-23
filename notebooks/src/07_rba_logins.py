# %% [markdown]
# # RBA Login Dataset — Risk-Based Authentication (User Behaviour)
#
# | | |
# |---|---|
# | **Source** | Kaggle `dasgroup/rba-dataset` |
# | **Origin** | Wiefling et al., "Pump Up Password Security!" (ACM TOPS 2022) — real SSO logins from a large online service, anonymized |
# | **License** | CC BY-NC 4.0 |
# | **Samples** | ~33M login events over ~1 year |
# | **Features** | timestamp, user ID, IP, country/region/city, ASN, user agent, browser/OS, device type, RTT, login success |
# | **Labels** | `Is Attack IP`, `Is Account Takeover` |
# | **Caveats** | Extreme size → stratified sample: ALL attack/ATO rows + benign sample (documented). NC license. |
# | **Production research suitability** | HIGH — real behavioural login telemetry with geo + device: ideal for impossible-travel features. |

# %%
import sys, glob
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import RAW, to_unified, dataset_report, numeric_summary, save_clean, save_unified_part

D = RAW / "behaviour" / "rba"
BENIGN_SAMPLE_FRAC = 0.06  # ~2M benign rows from ~33M — documented sampling

# %% [markdown]
# ## Chunked load with stratified sampling
# Keep 100% of `Is Attack IP` / `Is Account Takeover` rows, sample benign at 6%.
# Sampling is chunk-uniform with fixed seed → unbiased w.r.t. time.

# %%
from prep_utils import CLEAN
FAST_PATH = (CLEAN / "rba.parquet")
if FAST_PATH.exists():
    # idempotent fast path: sampling+cleaning already done in a prior run
    df = pd.read_parquet(FAST_PATH)
    print(f"loaded prior clean sample: {len(df):,} rows (delete {FAST_PATH} to rescan raw csv)")
else:
    csv = glob.glob(str(D / "*.csv"))[0]
    rng = np.random.default_rng(42)
    keep_parts, total = [], 0
    for chunk in pd.read_csv(csv, chunksize=1_000_000):
        total += len(chunk)
        atk = chunk[(chunk["Is Attack IP"]) | (chunk["Is Account Takeover"])]
        ben = chunk[~((chunk["Is Attack IP"]) | (chunk["Is Account Takeover"]))]
        ben = ben.sample(frac=BENIGN_SAMPLE_FRAC, random_state=42)
        keep_parts.append(pd.concat([atk, ben]))
    df = pd.concat(keep_parts, ignore_index=True)
    print(f"total rows scanned: {total:,}; kept: {len(df):,}")
df.head(3)

# %% [markdown]
# ## Cleaning

# %%
df.columns = [c.strip().lower().replace(" ", "_").replace("[ms]", "ms").replace("-", "_") for c in df.columns]
df = df.rename(columns={"round_trip_time_ms_": "rtt_ms", "round_trip_time_ms": "rtt_ms"})
rtt = [c for c in df.columns if "round" in c or "rtt" in c][0]
df = df.rename(columns={rtt: "rtt_ms"})
before = len(df)
df = df.drop_duplicates().reset_index(drop=True)
print(f"dropped {before - len(df)} duplicates")
print("missing:", {c: int(v) for c, v in df.isna().sum().items() if v})
if "rtt_ms_missing" not in df.columns:  # skip on fast path — already imputed
    df["rtt_ms_missing"] = df["rtt_ms"].isna().astype("int8")
    df["rtt_ms"] = df["rtt_ms"].fillna(df["rtt_ms"].median())
for c in ["country", "device_type", "browser_name_and_version", "os_name_and_version"]:
    if c in df.columns:
        df[c] = df[c].astype(str).fillna("unknown").astype("category")

# %% [markdown]
# ## Timestamp normalization — real timestamps here

# %%
if "login_timestamp" in df.columns:
    df["event_time"] = pd.to_datetime(df["login_timestamp"], utc=True, errors="coerce")
bad = int(df["event_time"].isna().sum())
print("unparseable timestamps:", bad)
df = df.dropna(subset=["event_time"]).sort_values("event_time").reset_index(drop=True)

# %% [markdown]
# ## Label verification

# %%
df["label_bin"] = ((df["is_attack_ip"]) | (df["is_account_takeover"])).astype("int8")
print(pd.crosstab(df["is_attack_ip"], df["is_account_takeover"]))
df["label_bin"].value_counts(normalize=True)

# %% [markdown]
# ## EDA

# %%
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 3, figsize=(15, 4))
df["country"].value_counts().head(12).plot.barh(ax=axes[0], title="top countries")
df.groupby(df["event_time"].dt.hour)["label_bin"].mean().plot(ax=axes[1], title="attack rate by hour (UTC)")
df["device_type"].value_counts().plot.bar(ax=axes[2], title="device types")
plt.tight_layout(); plt.savefig("../reports/rba_eda.png", dpi=110); plt.show()

# %%
numeric_summary(df, "rba")

# %% [markdown]
# ## Save clean + unified

# %%
drop_cols = [c for c in ["login_timestamp", "user_agent_string"] if c in df.columns]
clean = df.drop(columns=drop_cols)
save_clean(clean, "rba")
dataset_report(clean, "rba", label_col="label_bin",
               notes=f"Stratified sample: all attack/ATO + {BENIGN_SAMPLE_FRAC:.0%} benign of ~33M rows. Real timestamps.")

# %%
u = pd.DataFrame({
    "event_time": clean["event_time"],
    "event_subtype": np.where(clean["login_successful"], "login_success", "login_fail"),
    "user_id": clean["user_id"].astype(str),
    "device_id": clean["device_type"].astype(str),
    "src_ip": clean["ip_address"].astype(str),
    "country": clean["country"].astype(str),
    "duration_s": clean["rtt_ms"] / 1000.0,
    "severity": np.select([clean["is_account_takeover"], clean["is_attack_ip"]], [4, 3], 0).astype("int8"),
    "label": clean["label_bin"].astype("Int8"),
    "label_type": np.where(clean["is_account_takeover"], "account_takeover", "attack"),
    "time_is_synthetic": False,
})
attr_cols = ["region", "city", "asn", "browser_name_and_version", "os_name_and_version",
             "is_attack_ip", "is_account_takeover", "rtt_ms_missing"]
attr_cols = [c for c in attr_cols if c in clean.columns]
u[attr_cols] = clean[attr_cols]
u = to_unified(u, source_dataset="rba", event_domain="behaviour",
               event_type="login", label_type="account_takeover", attributes_cols=attr_cols,
               label_alias_exempt={"severity": (
                   "v1 mapping: severity is 4/3 exactly when is_account_takeover/is_attack_ip "
                   "is set, and label_bin is their disjunction -- so severity>=3 iff label==1 "
                   "(measured balanced accuracy 1.0000). Harmless for the v2 behaviour rebuild "
                   "because f_device_past_hisev_count is dropped from the behaviour contract, "
                   "so no feature reads severity. Re-map to ex-ante triage if rba is ever used "
                   "for a model that consumes device history.")})
save_unified_part(u, "rba")
u.head(3)
