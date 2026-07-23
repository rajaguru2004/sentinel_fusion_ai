"""Prometheus scrape endpoint."""
from __future__ import annotations

from fastapi import APIRouter, Request, Response

from .. import metrics as m

router = APIRouter(tags=["ops"])


@router.get("/metrics")
async def metrics_endpoint(request: Request) -> Response:
    feats = getattr(request.app.state, "features", None)
    breaker_open = feats.breaker_state == "open" if feats else None
    return Response(content=m.render(breaker_open),
                    media_type="text/plain; version=0.0.4")
