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
from prep_utils import UNIFIED, REPORTS, UNIFIED_COLUMNS, COMPACT_COLUMNS

parts = sorted(glob.glob(str(UNIFIED / "part_*.parquet")))
print(f"{len(parts)} parts")

_ARROW_TYPES = {
    "string": pa.string(), "category": pa.string(),
    "datetime64[ns, UTC]": pa.timestamp("ns", tz="UTC"),
    "Int32": pa.int32(), "Int8": pa.int8(),
    "float64": pa.float64(), "bool": pa.bool_(),
}
FULL_SCHEMA = pa.schema([pa.field(c, _ARROW_TYPES[t]) for c, t in UNIFIED_COLUMNS.items()])
COMPACT_SCHEMA = pa.schema([pa.field(c, _ARROW_TYPES[UNIFIED_COLUMNS[c]]) for c in COMPACT_COLUMNS])
BATCH = 500_000


def conform(t: pa.Table, schema: pa.Schema) -> pa.Table:
    """Widen a part to `schema`, filling columns it predates with nulls.

    Schema v2 added the banking block, so parts written under v1 are narrower.
    Re-running every loader just to add null columns would cost ~20 min of
    recompute for datasets whose *content* did not change (and whose models are
    frozen), so conform them here instead. This also means adding a canonical
    column in future never forces a full corpus rebuild.
    """
    cols = []
    for f in schema:
        cols.append(t.column(f.name).cast(f.type) if f.name in t.column_names
                    else pa.nulls(t.num_rows, f.type))
    return pa.Table.from_arrays(cols, schema=schema)

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
            writer.write_table(conform(pa.Table.from_batches([b]), FULL_SCHEMA))
    writer.close()
    print(f"full corpus written: {expected:,} rows")

# %% [markdown]
# ## Compact training corpus — stratified batch sampling

# %%
CAP = 150_000  # per (dataset, label-stratum)
rng = np.random.default_rng(42)

# ---------------------------------------------------------------------------
# Sequence-preserving sources: NEVER row-sampled.
#
# Row-stratified sampling silently destroys per-entity sequences, and that is
# what killed the fraud model's history features in v1: after sampling, PaySim
# had 158,262 distinct users across 158,265 rows, so `f_user_seq_no`,
# `f_user_secs_since_last`, `f_amount_z_user` and `f_amount_ratio_mean` were
# NaN/0 on 100% of fraud training rows and all four scored mean |SHAP| = 0.0.
#
# Measured events-per-user on the FULL parts (not the sample) shows only one
# financial source can carry history at all:
#
#   source         rows        users        median ev/user
#   sparkov        1,852,394   999          1471     <- keep whole
#   paysim         6,362,620   6,353,307    1        <- sequence-free BY DESIGN;
#                                                       sampling is not the cause
#   rba            4,787,377   1,394,695    1        <- ditto (behaviour)
#   cert_insider   8,082,113   5,000        792      (unlabeled)
#   beth           1,141,078   8            1779     (only 8 entities)
#
# So Sparkov is kept in full: it is the sole public source that can teach
# velocity and amount-vs-history, which is the reason it was acquired.
# Sampling it would reintroduce exactly the bug it was brought in to fix.
#
# FinSpark is here for the same reason and it matters MORE: the export spec asks
# for >=2M events, which would exceed the per-stratum cap and get row-sampled —
# shattering the whole-customer sequences the spec goes out of its way to
# demand, and silently recreating the v1 bug on the one source shaped like
# production. It is also the calibration authority, so its base rate must be
# preserved exactly.
NO_SAMPLE = {"sparkov", "finspark", "finspark_synth"}

samples, composition = [], []
for p in parts:
    name = p.split("part_")[-1].replace(".parquet", "")
    labels = pq.read_table(p, columns=["label"]).column("label").to_numpy(zero_copy_only=False)
    counts = pd.Series(labels).value_counts().to_dict()
    whole = name in NO_SAMPLE
    rates = {s: 1.0 for s in counts} if whole else {s: min(1.0, CAP / n) for s, n in counts.items()}
    pf = pq.ParquetFile(p)
    kept = 0
    for b in pf.iter_batches(batch_size=BATCH, columns=COMPACT_COLUMNS):
        t = conform(pa.Table.from_batches([b]), COMPACT_SCHEMA)
        lab = t.column("label").to_numpy(zero_copy_only=False)
        if whole:
            sub, w = t, np.ones(t.num_rows, dtype="float64")
        else:
            rate_arr = np.vectorize(rates.get)(lab)
            mask = rng.random(len(lab)) < rate_arr
            sub = t.filter(pa.array(mask))
            w = 1.0 / np.vectorize(rates.get)(lab[mask])
        sub = sub.append_column("sampling_weight", pa.array(w, pa.float64()))
        samples.append(sub)
        kept += sub.num_rows
        del t, sub
    composition.append({"dataset": name, "rows": int(len(labels)), "kept_compact": kept,
                        "sampled": not whole,
                        **{f"stratum_{s}": int(n) for s, n in counts.items()}})
    tag = "WHOLE (sequence-preserving)" if whole else \
          f"rates {dict((k, round(v, 4)) for k, v in rates.items())}"
    print(f"{name}: {len(labels):,} -> {kept:,} ({tag})")

# %% [markdown]
# ## Global temporal sort + integrity checks

# %%
# Sort and write in Arrow rather than round-tripping through pandas: keeping
# Sparkov whole roughly doubles the compact corpus, and a pandas copy of the
# full table is the peak-RAM step on a 16 GB box.
tbl = pa.concat_tables(samples)
del samples
tbl = tbl.sort_by([("event_time", "ascending"), ("event_id", "ascending")])
pq.write_table(tbl, UNIFIED / "unified_events_compact.parquet")

import pyarrow.compute as pc
# combine_chunks first: element-wise compare needs one contiguous array, not a
# ChunkedArray whose two slices have different chunk boundaries.
et = tbl.column("event_time").combine_chunks()
assert pc.all(pc.less_equal(et.slice(0, len(et) - 1), et.slice(1))).as_py(), "not time-sorted"
assert tbl.column("event_id").length() == pc.count_distinct(tbl.column("event_id")).as_py(), \
    "duplicate event_id"
assert pc.all(pc.is_in(tbl.column("label").drop_null(),
                       value_set=pa.array([-1, 0, 1], pa.int8()))).as_py(), "invalid label"
print(f"compact rows: {tbl.num_rows:,}")
print("time range:", pc.min(et).as_py(), "->", pc.max(et).as_py())

# Small pandas frame for the stats block below (a few narrow columns only).
compact = tbl.select(["event_domain", "label", "time_is_synthetic",
                      "source_dataset", "event_time"]).to_pandas()

# %%
comp = pd.DataFrame(composition)
comp.to_csv(REPORTS / "unified_composition.csv", index=False)
comp

# %%
stats = {
    "full_rows": int(expected),
    "compact_rows": int(len(compact)),
    "compact_columns": int(tbl.num_columns),   # NOT compact.shape[1]: `compact`
                                               # is a narrow stats-only projection
    "domains_compact": {str(k): int(v) for k, v in compact["event_domain"].value_counts().items()},
    "label_distribution_compact": {str(k): int(v) for k, v in compact["label"].value_counts().items()},
    "datasets_full": {r["dataset"]: r["rows"] for r in composition},
    "synthetic_time_share_compact": round(float(compact["time_is_synthetic"].mean()), 4),
}
(REPORTS / "unified_stats.json").write_text(json.dumps(stats, indent=2))
print(json.dumps(stats, indent=2))
