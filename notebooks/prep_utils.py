"""Shared preprocessing utilities for Sentinel Fusion AI Phase 1.

Every dataset notebook imports this. Keeps unified schema in ONE place.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
CLEAN = ROOT / "data" / "clean"
UNIFIED = ROOT / "data" / "unified"
REPORTS = ROOT / "reports"
for _d in (CLEAN, UNIFIED, REPORTS):
    _d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- schema ----
UNIFIED_COLUMNS: dict[str, str] = {
    "event_id": "string",
    "event_time": "datetime64[ns, UTC]",
    "event_domain": "category",
    "event_type": "category",
    "event_subtype": "category",
    "source_dataset": "category",
    "user_id": "string",
    "device_id": "string",
    "src_ip": "string",
    "dst_ip": "string",
    "src_port": "Int32",
    "dst_port": "Int32",
    "protocol": "category",
    "country": "category",
    "amount": "float64",
    "duration_s": "float64",
    "bytes_in": "float64",
    "bytes_out": "float64",
    "severity": "Int8",
    "label": "Int8",
    "label_type": "category",
    "attack_technique": "string",
    "time_is_synthetic": "bool",
    "attributes": "string",
}

DOMAINS = {"cyber", "financial", "behaviour", "threat_intel", "quantum"}
LABEL_TYPES = {"attack", "fraud", "insider", "account_takeover", "ioc", "quantum_risk", "none"}


def to_unified(df: pd.DataFrame, *, source_dataset: str, event_domain: str,
               event_type: str, label_type: str,
               attributes_cols: list[str] | None = None) -> pd.DataFrame:
    """Map a cleaned dataframe onto the unified schema.

    Caller pre-populates any core columns it has (event_time, label, severity, ...).
    Everything in `attributes_cols` is packed lossless into the `attributes` JSON column.
    Missing core columns are added as NA. Column order + dtypes enforced.
    """
    assert event_domain in DOMAINS, event_domain
    assert label_type in LABEL_TYPES, label_type
    out = df.copy()

    if attributes_cols:
        keep = [c for c in attributes_cols if c in out.columns]
        out["attributes"] = out[keep].apply(
            lambda r: json.dumps({k: v for k, v in r.items() if pd.notna(v)},
                                 default=str, separators=(",", ":")), axis=1)
        out = out.drop(columns=keep)

    out["source_dataset"] = source_dataset
    out["event_domain"] = event_domain
    if "event_type" not in out.columns:
        out["event_type"] = event_type
    if "label_type" not in out.columns:
        out["label_type"] = label_type
    if "event_id" not in out.columns:
        out["event_id"] = [f"{source_dataset}-{i}" for i in range(len(out))]
    if "time_is_synthetic" not in out.columns:
        out["time_is_synthetic"] = False

    for col, dtype in UNIFIED_COLUMNS.items():
        if col not in out.columns:
            if dtype == "float64":
                out[col] = np.nan
            elif dtype == "datetime64[ns, UTC]":
                out[col] = pd.NaT
            else:
                out[col] = pd.NA
        try:
            if dtype == "float64":
                out[col] = pd.to_numeric(out[col], errors="raise").astype("float64")
            else:
                out[col] = out[col].astype(dtype)
        except (TypeError, ValueError):
            if dtype == "datetime64[ns, UTC]":
                out[col] = pd.to_datetime(out[col], utc=True, errors="coerce")
            elif dtype == "float64":
                out[col] = out[col].astype("Float64").astype("float64")
            else:
                raise
    out = out[list(UNIFIED_COLUMNS)]
    validate_unified(out)
    return out


def validate_unified(df: pd.DataFrame) -> None:
    assert list(df.columns) == list(UNIFIED_COLUMNS), "column order mismatch"
    assert df["event_id"].is_unique, "duplicate event_id"
    assert df["label"].dropna().isin([-1, 0, 1]).all(), "invalid label values"
    assert df["severity"].dropna().between(0, 4).all(), "severity out of range"
    assert df["event_domain"].isin(DOMAINS).all(), "bad domain"


# ------------------------------------------------------------- reporting ----
def dataset_report(df: pd.DataFrame, name: str, *, label_col: str | None = None,
                   notes: str = "") -> dict:
    """Standard per-dataset stats blob. Saved to reports/<name>_stats.json."""
    rep = {
        "dataset": name,
        "rows": int(len(df)),
        "columns": int(df.shape[1]),
        "memory_mb": round(float(df.memory_usage(deep=True).sum()) / 1e6, 1),
        "duplicate_rows": int(df.duplicated().sum()),
        "missing_by_column": {c: int(v) for c, v in df.isna().sum().items() if v > 0},
        "dtypes": {c: str(t) for c, t in df.dtypes.items()},
        "notes": notes,
    }
    if label_col and label_col in df.columns:
        vc = df[label_col].value_counts(dropna=False)
        rep["label_distribution"] = {str(k): int(v) for k, v in vc.items()}
        if len(vc) > 1:
            rep["imbalance_ratio"] = round(float(vc.max() / vc.min()), 2)
    path = REPORTS / f"{name}_stats.json"
    path.write_text(json.dumps(rep, indent=2))
    print(f"report -> {path}")
    return rep


def numeric_summary(df: pd.DataFrame, name: str) -> pd.DataFrame:
    """describe() for numerics, persisted to reports/."""
    summ = df.select_dtypes(include=[np.number]).describe().T
    summ.to_csv(REPORTS / f"{name}_numeric_summary.csv")
    return summ


def iqr_outlier_share(s: pd.Series) -> float:
    q1, q3 = s.quantile([0.25, 0.75])
    iqr = q3 - q1
    if iqr == 0:
        return 0.0
    return float(((s < q1 - 1.5 * iqr) | (s > q3 + 1.5 * iqr)).mean())


def save_clean(df: pd.DataFrame, name: str) -> Path:
    p = CLEAN / f"{name}.parquet"
    df.to_parquet(p, index=False)
    print(f"clean -> {p} ({len(df):,} rows)")
    return p


def save_unified_part(df: pd.DataFrame, name: str) -> Path:
    p = UNIFIED / f"part_{name}.parquet"
    df.to_parquet(p, index=False)
    print(f"unified part -> {p} ({len(df):,} rows)")
    return p
