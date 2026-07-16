# %% [markdown]
# # Unified Dataset Assembly (streaming — hard memory bounds)
#
# Target machine: 16 GB RAM shared with IDE; final model must run <1 GB VRAM.
# Design decisions driven by that:
#
# 1. **Full corpus** `unified_events.parquet` (25.3M rows) — written by streaming
#    record batches (peak RAM = one 500k-row batch). Skipped if already valid.
#    Partition-sorted (each part internally time-sorted).
# 2. **Compact training corpus** `unified_events_compact.parquet` — per dataset,
#    per label stratum caps (benign / malicious / context each ≤ 150k rows),
#    `sampling_weight` = 1/rate restores population ratios. The bulky `attributes`
#    JSON column stays ONLY in the full corpus — the training corpus keeps the
#    24-column core minus attributes. Globally time-sorted.

# %%
import sys, glob, json
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from prep_utils import UNIFIED, REPORTS, UNIFIED_COLUMNS

parts = sorted(glob.glob(str(UNIFIED / "part_*.parquet")))
print(f"{len(parts)} parts")

_ARROW_TYPES = {
    "string": pa.string(), "category": pa.string(),
    "datetime64[ns, UTC]": pa.timestamp("ns", tz="UTC"),
    "Int32": pa.int32(), "Int8": pa.int8(),
    "float64": pa.float64(), "bool": pa.bool_(),
}
FULL_SCHEMA = pa.schema([pa.field(c, _ARROW_TYPES[t]) for c, t in UNIFIED_COLUMNS.items()])
BATCH = 500_000

# %% [markdown]
# ## Full corpus — streaming batch writer (idempotent)

# %%
out_full = UNIFIED / "unified_events.parquet"
expected = sum(pq.ParquetFile(p).metadata.num_rows for p in parts)
full_ok = False
if out_full.exists():
    try:
        full_ok = pq.ParquetFile(out_full).metadata.num_rows == expected
    except Exception:
        full_ok = False
if full_ok:
    print(f"full corpus already valid ({expected:,} rows) — skipping rewrite")
else:
    writer = pq.ParquetWriter(out_full, FULL_SCHEMA)
    for p in parts:
        pf = pq.ParquetFile(p)
        for b in pf.iter_batches(batch_size=BATCH):
            writer.write_table(pa.Table.from_batches([b]).cast(FULL_SCHEMA))
    writer.close()
    print(f"full corpus written: {expected:,} rows")

# %% [markdown]
# ## Compact training corpus — stratified batch sampling

# %%
CAP = 150_000  # per (dataset, label-stratum)
rng = np.random.default_rng(42)
COMPACT_COLS = [c for c in UNIFIED_COLUMNS if c != "attributes"]
COMPACT_SCHEMA = pa.schema([pa.field(c, _ARROW_TYPES[UNIFIED_COLUMNS[c]]) for c in COMPACT_COLS])

samples, composition = [], []
for p in parts:
    name = p.split("part_")[-1].replace(".parquet", "")
    labels = pq.read_table(p, columns=["label"]).column("label").to_numpy(zero_copy_only=False)
    counts = pd.Series(labels).value_counts().to_dict()
    rates = {s: min(1.0, CAP / n) for s, n in counts.items()}
    pf = pq.ParquetFile(p)
    kept = 0
    for b in pf.iter_batches(batch_size=BATCH, columns=COMPACT_COLS):
        t = pa.Table.from_batches([b]).cast(COMPACT_SCHEMA)
        lab = t.column("label").to_numpy(zero_copy_only=False)
        rate_arr = np.vectorize(rates.get)(lab)
        mask = rng.random(len(lab)) < rate_arr
        sub = t.filter(pa.array(mask))
        w = 1.0 / np.vectorize(rates.get)(lab[mask])
        sub = sub.append_column("sampling_weight", pa.array(w, pa.float64()))
        samples.append(sub)
        kept += sub.num_rows
        del t, sub
    composition.append({"dataset": name, "rows": int(len(labels)), "kept_compact": kept,
                        **{f"stratum_{s}": int(n) for s, n in counts.items()}})
    print(f"{name}: {len(labels):,} -> {kept:,} (rates {dict((k, round(v,4)) for k,v in rates.items())})")

# %% [markdown]
# ## Global temporal sort + integrity checks

# %%
compact = pa.concat_tables(samples).to_pandas()
del samples
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
    "full_rows": int(expected),
    "compact_rows": int(len(compact)),
    "compact_columns": int(compact.shape[1]),
    "domains_compact": {str(k): int(v) for k, v in compact["event_domain"].value_counts().items()},
    "label_distribution_compact": {str(k): int(v) for k, v in compact["label"].value_counts().items()},
    "datasets_full": {r["dataset"]: r["rows"] for r in composition},
    "synthetic_time_share_compact": round(float(compact["time_is_synthetic"].mean()), 4),
}
(REPORTS / "unified_stats.json").write_text(json.dumps(stats, indent=2))
print(json.dumps(stats, indent=2))
