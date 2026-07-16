# %% [markdown]
# # Unified Dataset Assembly (streaming — bounded memory)
#
# Earlier pandas-concat approach OOM-killed on 16 GB RAM. This version streams:
#
# 1. **Full corpus** `unified_events.parquet` — parts appended one at a time via
#    pyarrow `ParquetWriter` (peak RAM = largest single part). Parts are each
#    internally time-sorted; the full file is *partition-sorted* (sort on read
#    if a global order is required).
# 2. **Compact training corpus** `unified_events_compact.parquet` — built in the
#    same pass with arrow-level sampling: ALL malicious/context rows + benign
#    capped at 300k/dataset, `sampling_weight` restores population ratios.
#    Globally time-sorted (small enough for pandas). Sized for the <1 GB VRAM
#    deployment target.

# %%
import sys, glob, json
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pyarrow.compute as pc
from prep_utils import UNIFIED, REPORTS, UNIFIED_COLUMNS

parts = sorted(glob.glob(str(UNIFIED / "part_*.parquet")))
print(f"{len(parts)} parts:")
for p in parts:
    print(" -", p.split("/")[-1])

# %% [markdown]
# ## Single streaming pass: write full file + collect compact samples

# %%
BENIGN_CAP = 300_000
rng = np.random.default_rng(42)

# Canonical arrow schema — all-NA pandas columns land as arrow `null` type and
# empty categoricals lose their value type, so every part is force-cast to this.
_ARROW_TYPES = {
    "string": pa.string(), "category": pa.string(),
    "datetime64[ns, UTC]": pa.timestamp("ns", tz="UTC"),
    "Int32": pa.int32(), "Int8": pa.int8(),
    "float64": pa.float64(), "bool": pa.bool_(),
}
target_schema = pa.schema([pa.field(c, _ARROW_TYPES[t]) for c, t in UNIFIED_COLUMNS.items()])

writer = pq.ParquetWriter(UNIFIED / "unified_events.parquet", target_schema)
compact_tables, composition = [], []
out_full = UNIFIED / "unified_events.parquet"

for p in parts:
    t = pq.read_table(p)
    assert t.column_names == list(UNIFIED_COLUMNS), f"schema drift in {p}"
    t = t.cast(target_schema)
    writer.write_table(t)

    # ---- compact sampling (arrow-level, no pandas materialization) ----
    lab = t.column("label")
    ben_mask = pc.equal(lab, 0)
    ben_idx = np.flatnonzero(ben_mask.combine_chunks().to_numpy(zero_copy_only=False))
    rest_idx = np.flatnonzero(~pc.fill_null(ben_mask, False).combine_chunks().to_numpy(zero_copy_only=False))
    if len(ben_idx) > BENIGN_CAP:
        w = len(ben_idx) / BENIGN_CAP
        ben_idx = rng.choice(ben_idx, BENIGN_CAP, replace=False)
    else:
        w = 1.0
    sel = np.sort(np.concatenate([ben_idx, rest_idx]))
    sub = t.take(pa.array(sel))
    weights = np.where(np.isin(sel, ben_idx), w, 1.0)
    sub = sub.append_column("sampling_weight", pa.array(weights, pa.float64()))
    compact_tables.append(sub)

    name = p.split("part_")[-1].replace(".parquet", "")
    composition.append({"dataset": name, "rows": t.num_rows,
                        "benign": int(len(np.flatnonzero(ben_mask.combine_chunks().to_numpy(zero_copy_only=False)))),
                        "kept_compact": sub.num_rows, "benign_weight": round(w, 2)})
    print(f"{name}: {t.num_rows:,} rows -> compact {sub.num_rows:,} (w={w:.1f})")
    del t, sub

writer.close()
print("full corpus written:", out_full)

# %% [markdown]
# ## Compact corpus: global temporal sort + integrity checks

# %%
compact = pa.concat_tables(compact_tables).to_pandas()
del compact_tables
compact = compact.sort_values(["event_time", "event_id"]).reset_index(drop=True)
assert compact["event_time"].is_monotonic_increasing
assert compact["event_id"].is_unique
assert compact["label"].dropna().isin([-1, 0, 1]).all()
compact.to_parquet(UNIFIED / "unified_events_compact.parquet", index=False)
print(f"compact rows: {len(compact):,}")
print("time range:", compact["event_time"].min(), "->", compact["event_time"].max())

# %%
comp = pd.DataFrame(composition)
comp.to_csv(REPORTS / "unified_composition.csv", index=False)
comp

# %%
stats = {
    "full_rows": int(comp["rows"].sum()),
    "compact_rows": int(len(compact)),
    "columns": int(compact.shape[1]),
    "domains": {str(k): int(v) for k, v in compact["event_domain"].value_counts().items()},
    "label_distribution_compact": {str(k): int(v) for k, v in compact["label"].value_counts().items()},
    "datasets": {r["dataset"]: r["rows"] for r in composition},
    "synthetic_time_share_compact": round(float(compact["time_is_synthetic"].mean()), 4),
}
(REPORTS / "unified_stats.json").write_text(json.dumps(stats, indent=2))
print(json.dumps(stats, indent=2))
