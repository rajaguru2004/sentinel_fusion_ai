"""Data loading + reproducible per-source temporal split.

Split rule: within each source_dataset, sort by (event_time, event_id) and cut
at 70% / 85% row quantiles -> train / val / test. Deterministic (no RNG), keeps
temporal order inside every source, and prevents a whole dataset landing in one
split (sources have different synthetic epoch anchors, so a single global time
cut would do exactly that).
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .config import (ENGINEERED_PARQUET, FEATURES, QUANTUM_PART_PARQUET,
                     TRAIN_FRAC, VAL_FRAC, DOMAIN_OF_MODEL, ML_REPORTS)

QUANTUM_ATTRS = ["key_exchange", "cert_key_type", "data_class",
                 "cert_age_days", "cert_validity_days"]

META_COLS = ["event_id", "event_time", "event_domain", "source_dataset",
             "label", "sampling_weight"]


def needed_columns() -> list[str]:
    """Only columns the pipeline touches — keeps the 2M-row load small
    (16 GB RAM box; wide string columns like IPs/attributes stay on disk)."""
    cols = set(META_COLS)
    for spec in FEATURES.values():
        for c in spec["numeric"] + spec["categorical"]:
            if not c.startswith("q_"):  # joined later from the quantum part file
                cols.add(c)
    return sorted(cols)


def load_engineered() -> pd.DataFrame:
    """Engineered corpus with quantum native attributes joined (q_ prefix)."""
    df = pd.read_parquet(ENGINEERED_PARQUET, columns=needed_columns())

    # Target-leak scrub: for unsw_nb15/cicids2017 event_subtype IS the attack
    # category (attack_cat/Label mapped there at unify time) — null it so no
    # model can read the label. BETH keeps its subtype (= syscall, legit).
    leak = df["source_dataset"].isin(["unsw_nb15", "cicids2017"])
    df.loc[leak, "event_subtype"] = pd.NA
    df = df.sort_values(["event_time", "event_id"], kind="mergesort").reset_index(drop=True)

    qmask = df["event_domain"] == "quantum"
    qids = df.loc[qmask, "event_id"]
    qpart = pd.read_parquet(QUANTUM_PART_PARQUET, columns=["event_id", "attributes"])
    qpart = qpart[qpart["event_id"].isin(set(qids))]
    attrs = pd.json_normalize(qpart["attributes"].map(json.loads))
    attrs["event_id"] = qpart["event_id"].to_numpy()
    attrs = attrs[["event_id", *QUANTUM_ATTRS]].rename(
        columns={c: f"q_{c}" for c in QUANTUM_ATTRS})
    df = df.merge(attrs, on="event_id", how="left")
    return df


def temporal_split(df: pd.DataFrame) -> pd.Series:
    """Return 'train'/'val'/'test' assignment aligned to df.index."""
    split = pd.Series("train", index=df.index, dtype="object")
    for _, idx in df.groupby("source_dataset", observed=True).indices.items():
        idx = np.sort(idx)  # df already time-sorted; positional order = time order
        n = len(idx)
        t_end, v_end = int(n * TRAIN_FRAC), int(n * (TRAIN_FRAC + VAL_FRAC))
        split.iloc[idx[t_end:v_end]] = "val"
        split.iloc[idx[v_end:]] = "test"
    return split


def domain_slice(df: pd.DataFrame, split: pd.Series, model_key: str,
                 part: str, labeled_only: bool) -> pd.DataFrame:
    """Rows of one domain for one split part. labeled_only drops label==-1
    (cert_insider context rows — scored by the behaviour model, never used
    for supervised metrics)."""
    m = (df["event_domain"] == DOMAIN_OF_MODEL[model_key]) & (split == part)
    if labeled_only:
        m &= df["label"] >= 0
    return df.loc[m]


def write_split_manifest(df: pd.DataFrame, split: pd.Series) -> dict:
    """Persist split composition for reproducibility auditing."""
    comp = (pd.DataFrame({"source_dataset": df["source_dataset"],
                          "split": split, "label": df["label"]})
            .groupby(["source_dataset", "split"], observed=True)["label"]
            .agg(rows="size", positives=lambda s: int((s == 1).sum()),
                 unlabeled=lambda s: int((s == -1).sum())))
    manifest = {
        "rows_total": int(len(df)),
        "fractions": {"train": TRAIN_FRAC, "val": VAL_FRAC,
                      "test": round(1 - TRAIN_FRAC - VAL_FRAC, 2)},
        "rule": "per-source temporal quantile cut on (event_time, event_id) order",
        "composition": {f"{a}/{b}": row for (a, b), row in
                        comp.astype("int64").to_dict("index").items()},
    }
    (ML_REPORTS / "split_manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest
