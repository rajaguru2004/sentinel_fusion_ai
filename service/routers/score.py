"""Scoring endpoints — single event and batch."""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from .. import metrics
from ..auth import require_api_key
from ..normalize import to_event_dict
from ..schemas import BatchIn, BatchOut, EventIn, Explanation, ScoreOut
from ..settings import get_settings

router = APIRouter(tags=["score"], dependencies=[Depends(require_api_key)])


def _guard_clock(ev_dict: dict[str, Any]) -> None:
    settings = get_settings()
    et: datetime = ev_dict["event_time"]
    skew = (et - datetime.now(timezone.utc)).total_seconds()
    if skew > settings.reject_future_events_seconds:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"event_time is {int(skew)}s in the future")


async def _score_events(request: Request, events: list[EventIn],
                        explain: bool) -> list[ScoreOut]:
    st = request.app.state
    ev_dicts = [to_event_dict(e) for e in events]
    for d in ev_dicts:
        _guard_clock(d)

    feat_results = await st.features.build_many(ev_dicts)
    merged = [{**d, **feats}
              for d, (feats, _) in zip(ev_dicts, feat_results, strict=True)]
    rows = st.scorer.score(merged)

    settings = get_settings()
    out: list[ScoreOut] = []
    for i, row in enumerate(rows):
        detail = feat_results[i][1]
        row["degradation"] = detail
        row["degraded"] = detail.degraded          # legacy mirror
        expl = None
        if explain and settings.enable_explain and row["scored"]:
            raw = st.explainer.explain(merged[i])
            expl = Explanation(**raw) if raw else None
        so = ScoreOut(**row, explanation=expl)
        out.append(so)
        metrics.SCORED_TOTAL.labels(
            model=so.model or "none", risk_level=so.risk_level).inc()
        if detail.store_unavailable:
            metrics.DEGRADED_TOTAL.inc()
        if detail.user_history:
            metrics.COLD_ENTITY_TOTAL.labels(entity="user").inc()
        if detail.device_history:
            metrics.COLD_ENTITY_TOTAL.labels(entity="device").inc()
        metrics.RISK_SCORE.labels(model=so.model or "none").observe(so.risk_score)
    return out


@router.post("/score", response_model=ScoreOut)
async def score(request: Request, event: EventIn,
                explain: bool = Query(default=False)) -> ScoreOut:
    if explain and not get_settings().enable_explain:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED,
                            detail="explanations disabled")
    t0 = time.perf_counter()
    result = (await _score_events(request, [event], explain))[0]
    metrics.SCORE_LATENCY.labels(endpoint="score").observe(time.perf_counter() - t0)
    return result


@router.post("/score/batch", response_model=BatchOut)
async def score_batch(request: Request, body: BatchIn,
                      explain: bool = Query(default=False)) -> BatchOut:
    settings = get_settings()
    if len(body.events) > settings.max_batch:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"batch exceeds max_batch={settings.max_batch}")
    t0 = time.perf_counter()
    results = await _score_events(request, body.events, explain)
    metrics.SCORE_LATENCY.labels(endpoint="score_batch").observe(
        time.perf_counter() - t0)
    return BatchOut(results=results)
