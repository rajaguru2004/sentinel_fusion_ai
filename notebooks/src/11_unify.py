# %% [markdown]
# # Unified Dataset Assembly
#
# Concatenate all `data/unified/part_*.parquet` (each already schema-validated by
# `to_unified`) → global temporal sort → final integrity checks →
# `data/unified/unified_events.parquet`.

# %%
import sys, glob, json
sys.path.insert(0, "..")
import pandas as pd
from prep_utils import UNIFIED, REPORTS, UNIFIED_COLUMNS, validate_unified

parts = sorted(glob.glob(str(UNIFIED / "part_*.parquet")))
print(f"{len(parts)} parts:")
for p in parts:
    print(" -", p.split("/")[-1])

# %%
frames = []
for p in parts:
    d = pd.read_parquet(p)
    assert list(d.columns) == list(UNIFIED_COLUMNS), f"schema drift in {p}"
    frames.append(d)
df = pd.concat(frames, ignore_index=True)
# re-align categoricals across parts
for c, t in UNIFIED_COLUMNS.items():
    if t == "category":
        df[c] = df[c].astype("category")
print(f"unified rows: {len(df):,}")

# %% [markdown]
# ## Temporal ordering + integrity

# %%
df = df.sort_values(["event_time", "event_id"]).reset_index(drop=True)
assert df["event_time"].is_monotonic_increasing
assert df["event_id"].is_unique
validate_unified(df)
print("time range:", df["event_time"].min(), "->", df["event_time"].max())

# %%
summary = df.groupby(["event_domain", "source_dataset"], observed=True).agg(
    rows=("event_id", "size"),
    malicious=("label", lambda s: int((s == 1).sum())),
    unlabeled=("label", lambda s: int((s == -1).sum())),
    t_min=("event_time", "min"), t_max=("event_time", "max"),
    synthetic_time=("time_is_synthetic", "mean"),
)
summary

# %%
df.to_parquet(UNIFIED / "unified_events.parquet", index=False)
summary.reset_index().to_csv(REPORTS / "unified_composition.csv", index=False)
stats = {
    "rows": int(len(df)),
    "columns": int(df.shape[1]),
    "domains": {str(k): int(v) for k, v in df["event_domain"].value_counts().items()},
    "label_distribution": {str(k): int(v) for k, v in df["label"].value_counts().items()},
    "datasets": {str(k): int(v) for k, v in df["source_dataset"].value_counts().items()},
    "synthetic_time_share": round(float(df["time_is_synthetic"].mean()), 4),
}
(REPORTS / "unified_stats.json").write_text(json.dumps(stats, indent=2))
print(json.dumps(stats, indent=2))
