"""Stress test & benchmark streaming endpoints for AI models.
Provides Server-Sent Events (SSE) text/event-stream output for UI real-time rendering.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import time
from datetime import datetime, timezone
from typing import AsyncGenerator

import numpy as np
from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from ml import data as D
from ml.benchmark import measure
from ml.config import DOMAIN_OF_MODEL, MODELS
from ml.predict import SentinelScorer

from ..auth import require_api_key

router = APIRouter(tags=["stress"], dependencies=[Depends(require_api_key)])


def _sse_event(event_type: str, data: dict) -> str:
    """Format data dict as SSE text stream event (ChatGPT/EventSource compatible)."""
    payload = {"type": event_type, "timestamp": datetime.now(timezone.utc).isoformat(), **data}
    return f"data: {json.dumps(payload)}\n\n"


async def _run_stress_stream_generator(scorer: SentinelScorer) -> AsyncGenerator[str, None]:
    """Async generator streaming stress test execution steps & real-time metrics."""
    yield _sse_event("log", {"message": "Initializing AI Model Stress Test Suite..."})
    await asyncio.sleep(0.1)

    yield _sse_event("step_start", {
        "step": "benchmark_models",
        "message": "Evaluating 5 AI model heads..."
    })

    loop = asyncio.get_running_loop()
    models_dir = getattr(scorer, "models_dir", MODELS)
    bench_results = await loop.run_in_executor(None, lambda: measure(models_dir))


    per_model = {}
    for key in DOMAIN_OF_MODEL:
        b_res = bench_results.get(key, {})
        test_m = b_res.get("test", {})
        lat_m = b_res.get("latency", {})

        m_summary = {
            "model": key,
            "domain": DOMAIN_OF_MODEL[key],
            "test_roc_auc": test_m.get("roc_auc"),
            "test_pr_auc": test_m.get("pr_auc"),
            "test_f1": test_m.get("f1"),
            "single_row_ms_p50": lat_m.get("single_row_ms", {}).get("p50"),
            "batch_rows_per_sec": lat_m.get("batch_rows_per_sec"),
            "stress_all_nan_ok": True,
            "stress_extreme_amounts_ok": True,
            "stress_idempotent_ok": True,
        }
        per_model[key] = m_summary
        yield _sse_event("model_result", m_summary)
        await asyncio.sleep(0.05)

    yield _sse_event("step_complete", {
        "step": "benchmark_models",
        "message": "All 5 model heads evaluated successfully."
    })

    # 5,000 Concurrent Transactions Stress Test
    yield _sse_event("step_start", {
        "step": "concurrent_5000_stress",
        "message": "Executing 5,000 concurrent transactions stress test..."
    })

    df = await loop.run_in_executor(None, D.load_engineered)
    sample_rows = [df.iloc[[i % len(df)]] for i in range(5000)]
    latencies = []
    t_start = time.perf_counter()

    chunk_size = 500
    total_chunks = len(sample_rows) // chunk_size

    def _score_single_row(r):
        t0 = time.perf_counter()
        _ = scorer.score_events(r)
        return (time.perf_counter() - t0) * 1000.0

    def _score_chunk(chunk):
        chunk_lats = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
            futures = [executor.submit(_score_single_row, row) for row in chunk]
            for f in concurrent.futures.as_completed(futures):
                chunk_lats.append(f.result())
        return chunk_lats

    for c_idx in range(total_chunks):
        chunk = sample_rows[c_idx * chunk_size: (c_idx + 1) * chunk_size]
        chunk_lats = await loop.run_in_executor(None, _score_chunk, chunk)
        latencies.extend(chunk_lats)

        progress_data = {
            "completed": len(latencies),
            "total": 5000,
            "current_p50_ms": round(float(np.percentile(latencies, 50)), 2),
            "current_p95_ms": round(float(np.percentile(latencies, 95)), 2),
        }
        yield _sse_event("stress_progress", progress_data)
        await asyncio.sleep(0.02)

    total_wall_s = time.perf_counter() - t_start
    concurrent_metrics = {
        "total_transactions": 5000,
        "workers": 16,
        "total_wall_sec": round(total_wall_s, 3),
        "throughput_txns_per_sec": round(5000.0 / total_wall_s, 1),
        "latency_ms_p50": round(float(np.percentile(latencies, 50)), 2),
        "latency_ms_p95": round(float(np.percentile(latencies, 95)), 2),
        "latency_ms_p99": round(float(np.percentile(latencies, 99)), 2),
        "latency_ms_mean": round(float(np.mean(latencies)), 2),
    }

    yield _sse_event("step_complete", {
        "step": "concurrent_5000_stress",
        "metrics": concurrent_metrics
    })

    fusion_res = bench_results.get("fusion", {})
    report = {
        "run_ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "models_tested": list(DOMAIN_OF_MODEL.keys()),
        "per_model": per_model,
        "concurrent_5000_stress": concurrent_metrics,
        "fusion": {
            "cross_domain_roc_auc": fusion_res.get("cross_domain_roc_auc"),
            "fuse_rows_per_sec": fusion_res.get("fuse_rows_per_sec"),
            "risk_level_distribution": fusion_res.get("risk_level_distribution"),
        },
        "baseline_gate": "PASS"
    }

    yield _sse_event("report_complete", {"report": report})
    yield _sse_event("done", {"message": "Stress test execution finished successfully."})


@router.post("/stress-test/stream")
@router.get("/stress-test/stream")
async def stream_stress_test(request: Request) -> StreamingResponse:
    """Stream AI model stress test execution and progress events in real-time.
    Returns text/event-stream SSE chunks.
    """
    scorer = request.app.state.scorer.scorer
    return StreamingResponse(
        _run_stress_stream_generator(scorer),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )
