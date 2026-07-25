"""Counterfactual Analysis Router — POST /score/counterfactual."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from ..auth import require_api_key
from ..normalize import to_event_dict
from ..schemas import CounterfactualRequest, CounterfactualResponse, EventIn, RiskLevel
from ..settings import get_settings

router = APIRouter(tags=["counterfactual"], dependencies=[Depends(require_api_key)])


@router.post("/score/counterfactual", response_model=CounterfactualResponse)
async def analyze_counterfactual(
    request: Request,
    body: CounterfactualRequest,
) -> CounterfactualResponse:
    """Generate counterfactual recommendations to lower event risk level."""
    st = request.app.state
    if not hasattr(st, "counterfactual_engine") or st.counterfactual_engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Counterfactual analysis engine is not initialized",
        )

    ev_dict = to_event_dict(body.event)
    response = await st.counterfactual_engine.generate_counterfactuals(
        event_dict=ev_dict,
        target_risk_level=body.target_risk_level,
        max_recommendations=body.max_recommendations,
    )
    return response
