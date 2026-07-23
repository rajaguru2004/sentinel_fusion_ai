"""Prometheus scrape endpoint."""
from __future__ import annotations

from fastapi import APIRouter, Response

from .. import metrics as m

router = APIRouter(tags=["ops"])


@router.get("/metrics")
async def metrics_endpoint() -> Response:
    return Response(content=m.render(), media_type="text/plain; version=0.0.4")
