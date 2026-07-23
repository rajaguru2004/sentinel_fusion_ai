"""Offline batch scoring CLI — score a file of unified events with the trained
models, no service required.

    .venv/bin/python -m ml.score_batch --input events.parquet --output scored.parquet

If the input lacks engineered ``f_*`` columns they are computed with
``feature_core.engineer_batch`` (whole-file, time-ordered) so results match the
training-time features. This is the offline counterpart to the online store used
by the API; use it for backfills, evaluation, and reconciliation.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from .feature_core import ENGINEERED_F, engineer_batch
from .predict import SentinelScorer


def _read(path: Path) -> pd.DataFrame:
    if path.suffix in (".parquet", ".pq"):
        return pd.read_parquet(path)
    if path.suffix == ".csv":
        return pd.read_csv(path)
    raise ValueError(f"unsupported input format: {path.suffix}")


def _write(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix in (".parquet", ".pq"):
        df.to_parquet(path, index=False)
    else:
        df.to_csv(path, index=False)


def run(input_path: Path, output_path: Path, models_dir: Path | None = None) -> int:
    df = _read(input_path)
    if "event_domain" not in df.columns:
        raise ValueError("input missing required column 'event_domain'")
    if "event_time" in df.columns:
        df = df.sort_values(["event_time", "event_id"], kind="mergesort").reset_index(
            drop=True)
    if not any(c in df.columns for c in ENGINEERED_F):
        df = engineer_batch(df)

    scorer = SentinelScorer(models_dir) if models_dir else SentinelScorer()
    scored = scorer.score_events(df)
    if "event_id" in df.columns:
        scored.insert(0, "event_id", df["event_id"].to_numpy())
    _write(scored, output_path)
    print(f"scored {len(scored)} events -> {output_path}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Batch-score unified events.")
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--models-dir", type=Path, default=None)
    args = ap.parse_args()
    return run(args.input, args.output, args.models_dir)


if __name__ == "__main__":
    raise SystemExit(main())
