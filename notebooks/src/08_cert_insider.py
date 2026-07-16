# %% [markdown]
# # CERT Insider Threat r4.2 (subset) — User Activity Logs
#
# | | |
# |---|---|
# | **Source** | Kaggle `nitishabharathi/cert-insider-threat` (subset of CMU CERT r4.2) |
# | **Origin** | CMU SEI CERT Division + ExactData LLC — simulated 1000-user org, 18 months |
# | **License** | CMU research use |
# | **Content** | logon.csv, device.csv (USB), file.csv, email.csv, http.csv, psychometric.csv |
# | **Labels** | Ground-truth insider list ships separately (answers archive). If `insiders.csv` is present it is used; otherwise rows are labeled -1 (anomaly-detection use) — documented. |
# | **Caveats** | Fully simulated org (realistic format, synthetic behaviour). http.csv sampled if huge. |
# | **Production research suitability** | MEDIUM-HIGH — the standard insider-threat research corpus. |

# %%
import sys, glob
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import RAW, to_unified, dataset_report, save_clean, save_unified_part

D = RAW / "behaviour" / "cert_insider"
print("files:", sorted(p.split("/")[-1] for p in glob.glob(str(D / "**" / "*.csv"), recursive=True)))

# %% [markdown]
# ## Optional ground truth
# r4.2 answers (insiders per scenario) are a separate download. Use if present.

# %%
ins_files = glob.glob(str(D / "**" / "insider*"), recursive=True) + glob.glob(str(D / "**" / "answers*"), recursive=True)
insiders = set()
if ins_files:
    ins = pd.read_csv(ins_files[0])
    ucol = next(c for c in ins.columns if "user" in c.lower())
    insiders = set(ins[ucol].astype(str))
print(f"ground-truth insiders available: {len(insiders)}")
HAS_LABELS = len(insiders) > 0

# %% [markdown]
# ## Load activity streams (logon, device/USB, file; email+http sampled)

# %%
def find(name):
    hits = glob.glob(str(D / "**" / f"{name}.csv"), recursive=True)
    return hits[0] if hits else None

frames = []
specs = [
    ("logon", "logon", None),       # id, date, user, pc, activity (Logon/Logoff)
    ("device", "usb", None),        # USB Connect/Disconnect
    ("file", "file_access", 1_500_000),
    ("email", "email", 1_500_000),
    ("http", "web", 1_500_000),
]
BULKY = {"content"}  # free-text payloads — drop at read time to bound memory
for fname, etype, cap in specs:
    p = find(fname)
    if not p:
        print(f"skip {fname} (absent)")
        continue
    it = pd.read_csv(p, chunksize=500_000)
    parts, n = [], 0
    for ch in it:
        ch = ch.drop(columns=[c for c in ch.columns if c.lower() in BULKY])
        parts.append(ch)
        n += len(ch)
        if cap and n >= cap:
            print(f"{fname}: capped at {n:,} rows (documented sampling)")
            break
    d = pd.concat(parts, ignore_index=True)
    d.columns = [c.strip().lower() for c in d.columns]
    d["stream"] = fname
    d["event_type_norm"] = etype
    frames.append(d)
    print(f"{fname}: {len(d):,} rows")
df = pd.concat(frames, ignore_index=True)
print("total:", len(df))

# %% [markdown]
# ## Cleaning + timestamps (real simulated-org timestamps, parse them)

# %%
before = len(df)
df = df.drop_duplicates(subset=[c for c in ["id", "date", "user", "pc", "stream"] if c in df.columns]).reset_index(drop=True)
print(f"dropped {before - len(df)} duplicates")
df["event_time"] = pd.to_datetime(df["date"], format="%m/%d/%Y %H:%M:%S", utc=True, errors="coerce")
bad = int(df["event_time"].isna().sum())
if bad:
    df.loc[df["event_time"].isna(), "event_time"] = pd.to_datetime(
        df.loc[df["event_time"].isna(), "date"], utc=True, errors="coerce")
df = df.dropna(subset=["event_time", "user"]).sort_values("event_time").reset_index(drop=True)
print("unparseable dropped:", bad - int(df["date"].isna().sum()))

# %% [markdown]
# ## Labels

# %%
if HAS_LABELS:
    df["label_bin"] = df["user"].astype(str).isin(insiders).astype("int8")
else:
    df["label_bin"] = np.int8(-1)
print(df["label_bin"].value_counts().to_dict())

# %% [markdown]
# ## EDA

# %%
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 3, figsize=(15, 4))
df["stream"].value_counts().plot.bar(ax=axes[0], title="events by stream")
df.set_index("event_time").resample("W")["stream"].count().plot(ax=axes[1], title="events per week")
df["event_time"].dt.hour.value_counts().sort_index().plot(ax=axes[2], title="events by hour")
plt.tight_layout(); plt.savefig("../reports/cert_insider_eda.png", dpi=110); plt.show()

# %% [markdown]
# ## Save clean + unified

# %%
keep = [c for c in ["event_time", "user", "pc", "activity", "to", "from", "url",
                    "filename", "content", "stream", "event_type_norm", "label_bin"] if c in df.columns]
clean = df[keep].copy()
if "content" in clean.columns:
    clean = clean.drop(columns=["content"])  # bulky free text, not needed Phase 1
save_clean(clean, "cert_insider")
dataset_report(clean, "cert_insider", label_col="label_bin",
               notes="r4.2 subset; email/http capped at 1.5M rows each; label=-1 if answers file absent (anomaly-detection use).")

# %%
act = clean["activity"].astype(str).str.lower() if "activity" in clean.columns else pd.Series("", index=clean.index)
sub = clean["event_type_norm"].astype(str)
sub = np.where(act.isin(["logon", "logoff", "connect", "disconnect"]), sub + "_" + act, sub)
u = pd.DataFrame({
    "event_time": clean["event_time"],
    "event_subtype": sub,
    "user_id": clean["user"].astype(str),
    "device_id": clean["pc"].astype(str) if "pc" in clean.columns else pd.NA,
    "severity": np.where(clean["label_bin"] == 1, 3, 0).astype("int8"),
    "label": clean["label_bin"].astype("Int8"),
    "time_is_synthetic": False,
})
attr = [c for c in ["url", "filename", "to", "from", "stream"] if c in clean.columns]
u[attr] = clean[attr]
u = to_unified(u, source_dataset="cert_insider", event_domain="behaviour",
               event_type="user_activity", label_type="insider", attributes_cols=attr)
save_unified_part(u, "cert_insider")
u.head(3)
