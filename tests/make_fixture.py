"""Generate the committed test fixture from the full corpus.

    .venv/bin/python -m tests.make_fixture

Per source_dataset: a **systematic** sample (every k-th row in
(event_time, event_id) order) plus up to 1000 evenly-spaced positives.

Why systematic rather than head/tail + random positives (the previous scheme):
head and tail are dense, contiguous *time windows*, so positives sampled from
the whole timeline sort into the middle of the fixture and land entirely in the
train slice. Sparkov, at a 0.5% fraud rate, ended up with 1000 positives in
train and **zero in val/test** — `roc_auc` came out NaN and the "models learn
signal" gate failed on an artefact of the fixture, not the model.

Systematic sampling preserves temporal spread *and* the source's positive rate,
so a 70/15/15 temporal split of the fixture mirrors the split of the real
corpus. Output ~60K rows, a few MB, committed to git (data/ itself is
gitignored; this is what makes fast tests portable).
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from ml.config import ENGINEERED_PARQUET, QUANTUM_PART_PARQUET
from ml.data import needed_columns

FIXTURES = Path(__file__).resolve().parent / "fixtures"
MINI_EVENTS = FIXTURES / "mini_events.parquet"
MINI_QPART = FIXTURES / "mini_quantum_part.parquet"

TARGET_ROWS = 3000     # systematic sample size per source
EXTRA_POS = 1000       # additional evenly-spaced positives per source


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    df = pd.read_parquet(ENGINEERED_PARQUET, columns=needed_columns())
    df = df.sort_values(["event_time", "event_id"], kind="mergesort").reset_index(drop=True)

    parts = []
    for _, g in df.groupby("source_dataset", observed=True):
        step = max(1, len(g) // TARGET_ROWS)
        chunk = g.iloc[::step]                       # spread across the timeline
        pos = g[g["label"] == 1]
        if len(pos):
            # Evenly spaced, not random: guarantees positives in every temporal
            # third, hence in train AND val AND test.
            pstep = max(1, len(pos) // EXTRA_POS)
            chunk = pd.concat([chunk, pos.iloc[::pstep]])
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
