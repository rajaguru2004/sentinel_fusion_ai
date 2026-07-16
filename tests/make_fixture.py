"""Generate the committed test fixture from the full corpus.

    .venv/bin/python -m tests.make_fixture

Per source_dataset: first 1500 + last 1500 rows in (event_time, event_id)
order — keeps temporal structure so temporal_split still yields non-empty
train/val/test per source — plus up to 1000 additional positives (seed 42)
so supervised models have signal. Output ~60K rows, a few MB, committed to
git (data/ itself is gitignored; this is what makes fast tests portable).
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from ml.config import ENGINEERED_PARQUET, QUANTUM_PART_PARQUET, SEED
from ml.data import needed_columns

FIXTURES = Path(__file__).resolve().parent / "fixtures"
MINI_EVENTS = FIXTURES / "mini_events.parquet"
MINI_QPART = FIXTURES / "mini_quantum_part.parquet"

HEAD_TAIL = 1500
EXTRA_POS = 1000


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    df = pd.read_parquet(ENGINEERED_PARQUET, columns=needed_columns())
    df = df.sort_values(["event_time", "event_id"], kind="mergesort").reset_index(drop=True)

    parts = []
    for _, g in df.groupby("source_dataset", observed=True):
        chunk = pd.concat([g.head(HEAD_TAIL), g.tail(HEAD_TAIL)])
        pos = g[g["label"] == 1]
        if len(pos):
            chunk = pd.concat([chunk, pos.sample(min(EXTRA_POS, len(pos)),
                                                 random_state=SEED)])
        parts.append(chunk.drop_duplicates(subset="event_id"))
    mini = (pd.concat(parts)
            .sort_values(["event_time", "event_id"], kind="mergesort")
            .reset_index(drop=True))
    mini.to_parquet(MINI_EVENTS, index=False)

    qids = set(mini.loc[mini["event_domain"] == "quantum", "event_id"])
    qpart = pd.read_parquet(QUANTUM_PART_PARQUET, columns=["event_id", "attributes"])
    qpart[qpart["event_id"].isin(qids)].to_parquet(MINI_QPART, index=False)

    print(f"{MINI_EVENTS.name}: {len(mini):,} rows, "
          f"{MINI_EVENTS.stat().st_size / 1e6:.1f} MB")
    print(mini.groupby(["event_domain"], observed=True)["label"]
          .value_counts().unstack(fill_value=0))


if __name__ == "__main__":
    main()
