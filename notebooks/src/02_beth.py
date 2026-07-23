# %% [markdown]
# # BETH — Endpoint Kernel-Process Telemetry (eBPF)
#
# | | |
# |---|---|
# | **Source** | Kaggle `katehighnam/beth-dataset` |
# | **Origin** | Highnam et al., "BETH Dataset: Real Cybersecurity Data for Anomaly Detection Research" (ICML workshop 2021) |
# | **License** | CC BY 4.0 |
# | **Samples** | ~1.14M kernel process events (train/val/test splits, 8 hosts, honeypot compromise) |
# | **Features** | processId, parentProcessId, userId, processName, eventName, args, returnValue, ... |
# | **Labels** | `sus` (suspicious) and `evil` (confirmed malicious) |
# | **Caveats** | `timestamp` = seconds since host boot → synthetic anchor applied (flagged). |
# | **Production research suitability** | HIGH — real honeypot compromise, process-level EDR-like telemetry. |

# %%
import sys
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import RAW, to_unified, dataset_report, numeric_summary, save_clean, save_unified_part

D = RAW / "cyber" / "beth"

# %% [markdown]
# ## Load — official train/val/test splits

# %%
parts = []
for split in ["training", "validation", "testing"]:
    p = pd.read_csv(D / f"labelled_{split}_data.csv")
    p["split"] = split
    parts.append(p)
df = pd.concat(parts, ignore_index=True)
print(df.shape)
df.head(3)

# %% [markdown]
# ## Cleaning

# %%
before = len(df)
df = df.drop_duplicates(subset=[c for c in df.columns if c != "split"]).reset_index(drop=True)
print(f"dropped {before - len(df)} duplicates")
print("missing:", {c: int(v) for c, v in df.isna().sum().items() if v})
df["processName"] = df["processName"].astype(str).str.strip()
df["eventName"] = df["eventName"].astype(str).str.strip().astype("category")
# BETH convention: userId >= 1000 → external/regular user, else system account
df["is_system_user"] = (df["userId"] < 1000)

# %% [markdown]
# ## Label verification
# `evil` ⊆ malicious; `sus` = suspicious. Every evil row should also make sense
# as at least suspicious per paper — check overlap, build final binary label.

# %%
print(pd.crosstab(df["sus"], df["evil"]))
df["label_bin"] = (df["evil"] == 1).astype("int8")
df["label_bin"].value_counts(normalize=True)

# %% [markdown]
# ## Timestamp normalization
# `timestamp` = seconds since boot per host. Anchor each host at the dataset's
# capture epoch (May 2021) → synthetic but order-preserving per host.

# %%
anchor = pd.Timestamp("2021-05-01 00:00:00", tz="UTC")
df["event_time"] = anchor + pd.to_timedelta(df["timestamp"], unit="s")
df = df.sort_values("event_time").reset_index(drop=True)
df["event_time"].agg(["min", "max"])

# %% [markdown]
# ## EDA

# %%
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 3, figsize=(15, 4))
df["eventName"].value_counts().head(15).plot.barh(ax=axes[0], title="top syscall events")
df.groupby("split")["label_bin"].mean().plot.bar(ax=axes[1], title="evil rate by split")
df["processName"].value_counts().head(12).plot.barh(ax=axes[2], title="top processes")
plt.tight_layout(); plt.savefig("../reports/beth_eda.png", dpi=110); plt.show()

# %%
numeric_summary(df, "beth")

# %% [markdown]
# ## Save clean + unified

# %%
keep = ["event_time", "processId", "parentProcessId", "userId", "processName",
        "eventName", "argsNum", "returnValue", "sus", "evil", "label_bin",
        "is_system_user", "split", "hostName" if "hostName" in df.columns else "mountNamespace"]
keep = [c for c in dict.fromkeys(keep) if c in df.columns]
clean = df[keep].copy()
save_clean(clean, "beth")
dataset_report(clean, "beth", label_col="label_bin",
               notes="timestamp = sec-since-boot anchored to 2021-05-01 UTC (synthetic, order-preserving).")

# %%
u = pd.DataFrame({
    "event_time": clean["event_time"],
    "event_subtype": clean["eventName"].astype(str),
    "user_id": clean["userId"].astype(str),
    "device_id": clean["hostName"].astype(str) if "hostName" in clean.columns else pd.NA,
    "severity": np.select([df["evil"] == 1, df["sus"] == 1], [4, 2], 1).astype("int8"),
    "label": clean["label_bin"],
    "time_is_synthetic": True,
})
attr_cols = ["processId", "parentProcessId", "processName", "argsNum", "returnValue", "sus", "split"]
u[attr_cols] = clean[attr_cols]
u = to_unified(u, source_dataset="beth", event_domain="cyber",
               event_type="process_exec", label_type="attack", attributes_cols=attr_cols,
               label_alias_exempt={"severity": (
                   "v1 mapping: severity>=3 iff evil==1, so it reproduces the label exactly "
                   "(measured balanced accuracy 1.0000). Retained UNCHANGED because the cyber "
                   "model is frozen in schema v2 and must stay bit-comparable; the leak reaches "
                   "the model via f_device_past_hisev_count, which is documented in "
                   "reports/ml/MODELS.md and dropped from the fraud/behaviour contracts. "
                   "Fix this mapping if beth is ever retrained.")})
save_unified_part(u, "beth")
u.head(3)
