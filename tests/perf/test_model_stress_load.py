"""Sustained load & performance stress tests on real AI model artifacts.
"""
from __future__ import annotations

import concurrent.futures
import time

import numpy as np
import pandas as pd
import pytest

from ml.config import SLA
from ml.predict import SentinelScorer

pytestmark = pytest.mark.perf


@pytest.fixture(scope="module")
def load_scorer(real_artifacts):
    return SentinelScorer(real_artifacts)


@pytest.fixture(scope="module")
def large_event_batch(full_frame):
    # Repeat full_frame to get at least 100,000 rows if needed
    if len(full_frame) >= 100_000:
        return full_frame.head(100_000)
    repeats = (100_000 // len(full_frame)) + 1
    return pd.concat([full_frame] * repeats, ignore_index=True).head(100_000)


def test_scorer_10k_batch_time(load_scorer, large_event_batch):
    batch = large_event_batch.head(10_000)
    t0 = time.perf_counter()
    out = load_scorer.score_events(batch)
    elapsed = time.perf_counter() - t0
    assert len(out) == 10_000
    assert elapsed < 5.0, f"10k batch took {elapsed:.2f}s (budget: 5.0s)"


def test_scorer_100k_batch_throughput(load_scorer, large_event_batch):
    batch = large_event_batch.head(100_000)
    t0 = time.perf_counter()
    out = load_scorer.score_events(batch)
    elapsed = time.perf_counter() - t0
    throughput = len(batch) / elapsed
    assert len(out) == 100_000
    assert throughput >= SLA["batch_rows_per_sec_min"], f"Throughput {throughput:.0f} rows/s < SLA {SLA['batch_rows_per_sec_min']}"


def test_scorer_1k_concurrent_rows_no_race(load_scorer, large_event_batch):
    batch = large_event_batch.head(1_000)
    single_thread_out = load_scorer.score_events(batch)

    # Split into 10 chunks of 100 rows and score concurrently across threads
    chunks = [batch.iloc[i * 100: (i + 1) * 100] for i in range(10)]

    def _worker(df_chunk):
        return load_scorer.score_events(df_chunk)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(_worker, chunk) for chunk in chunks]
        results = [f.result() for f in futures]

    concat_out = pd.concat(results, axis=0)
    pd.testing.assert_series_equal(
        single_thread_out["risk_score"],
        concat_out["risk_score"],
        check_names=False
    )


def test_cold_start_under_sla(real_artifacts):
    t0 = time.perf_counter()
    _ = SentinelScorer(real_artifacts)
    elapsed = time.perf_counter() - t0
    assert elapsed < SLA["scorer_cold_start_s"], f"Cold start took {elapsed:.2f}s >= SLA {SLA['scorer_cold_start_s']}s"


def test_repeated_score_no_leak(load_scorer, large_event_batch):
    import psutil
    batch = large_event_batch.head(20_000)
    proc = psutil.Process()

    # Pass 1
    _ = load_scorer.score_events(batch)
    rss_pass1 = proc.memory_info().rss / 1e6

    # Pass 2 & 3
    for _ in range(3):
        _ = load_scorer.score_events(batch)

    rss_pass4 = proc.memory_info().rss / 1e6
    delta_mb = rss_pass4 - rss_pass1
    assert delta_mb < 50.0, f"Memory grew by {delta_mb:.2f} MB across repeated runs"


def test_scorer_5000_concurrent_transactions(load_scorer, large_event_batch):
    """Stress test: 5,000 concurrent transaction requests submitted via worker pool.
    Measures latency per transaction (p50, p95, p99) and total throughput.
    """
    rows = [large_event_batch.iloc[[i % len(large_event_batch)]] for i in range(5000)]
    latencies = []

    def _score_single(df_row):
        t0 = time.perf_counter()
        _ = load_scorer.score_events(df_row)
        return (time.perf_counter() - t0) * 1000.0  # ms

    t_start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
        futures = [executor.submit(_score_single, row) for row in rows]
        for f in concurrent.futures.as_completed(futures):
            latencies.append(f.result())

    total_wall_s = time.perf_counter() - t_start
    p50 = float(np.percentile(latencies, 50))
    p95 = float(np.percentile(latencies, 95))
    p99 = float(np.percentile(latencies, 99))
    throughput = 5000.0 / total_wall_s

    print(f"\n--- 5,000 Concurrent Transactions Stress Results ---")
    print(f"Total Wall Time: {total_wall_s:.3f}s")
    print(f"Throughput: {throughput:.1f} txns/sec")
    print(f"Latency p50: {p50:.2f} ms")
    print(f"Latency p95: {p95:.2f} ms")
    print(f"Latency p99: {p99:.2f} ms")

    assert len(latencies) == 5000
    assert p50 < 500.0, f"p50 latency {p50:.2f}ms exceeds SLA"


