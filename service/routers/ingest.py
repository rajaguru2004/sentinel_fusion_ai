"""Ingest-only endpoint — build history without scoring (requirements §3.1).

`/score` both scores *and* advances the feature store. The bank has context
events — logins, beneficiary add/activate, balance checks — that should build a
customer's history and velocity but do not need a verdict on the request path.
With no cheap way to stream them the store stays empty, so every payment scores
with `f_user_seq_no = NaN` and velocity never fires.

This runs the same `snapshot_and_advance` as `/score`, skips model inference and
SHAP entirely, and returns `202 Accepted`. It shares the `event_id` idempotency
guard (§3.2), so fire-and-forget retries are safe.
"""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status

from .. import metrics
from ..auth import require_api_key
from ..normalize import to_event_dict
from ..schemas import BatchIn, EventIn, IngestOut
from ..settings import get_settings

router = APIRouter(tags=["ingest"], dependencies=[Depends(require_api_key)])


async def _ingest(request: Request, events: list[EventIn]) -> IngestOut:
    st = request.app.state
    ev_dicts: list[dict[str, Any]] = [to_event_dict(e) for e in events]
    t0 = time.perf_counter()
    results = await st.features.build_many(ev_dicts)
    metrics.SCORE_LATENCY.labels(endpoint="ingest").observe(time.perf_counter() - t0)
    degraded = sum(1 for _, d in results if d.store_unavailable)
    metrics.INGESTED_TOTAL.inc(len(events))
    if degraded:
        metrics.DEGRADED_TOTAL.inc(degraded)
    return IngestOut(accepted=len(events) - degraded, rejected=degraded)


@router.post("/ingest", response_model=IngestOut,
             status_code=status.HTTP_202_ACCEPTED)
async def ingest(request: Request, event: EventIn) -> IngestOut:
    return await _ingest(request, [event])


@router.post("/ingest/batch", response_model=IngestOut,
             status_code=status.HTTP_202_ACCEPTED)
async def ingest_batch(request: Request, body: BatchIn) -> IngestOut:
    settings = get_settings()
    if len(body.events) > settings.max_batch:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"batch exceeds max_batch={settings.max_batch}")
    return await _ingest(request, body.events)
