"""Liveness and readiness probes (unauthenticated — for orchestrators/LBs)."""
from __future__ import annotations

from fastapi import APIRouter, Request, Response, status

from ..schemas import HealthOut, ReadyOut

router = APIRouter(tags=["ops"])


@router.get("/health", response_model=HealthOut)
async def health() -> HealthOut:
    return HealthOut()


@router.get("/ready", response_model=ReadyOut)
async def ready(request: Request, response: Response) -> ReadyOut:
    st = request.app.state
    scorer_loaded = getattr(st, "scorer", None) is not None
    store_ok = False
    if getattr(st, "store", None) is not None:
        try:
            store_ok = await st.store.ping()
        except Exception:
            store_ok = False
    ready = scorer_loaded and store_ok
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadyOut(ready=ready, scorer_loaded=scorer_loaded, store_ok=store_ok,
                    model_version=getattr(st, "model_version", "unknown"),
                    contract_hash=getattr(st, "contract_hash", "unknown"),
                    store_breaker=(st.features.breaker_state
                                   if getattr(st, "features", None) else "unknown"))
