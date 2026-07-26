"""Investigation endpoint — AI Attack Replay & Next Attack Prediction.

POST /investigate
  Body: EventIn (same as /score)
  Query: sentinel_mode: bool = True

Response: AttackReplayResponse

Requires cyber domain event. Other domains return HTTP 422.
"""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from .. import metrics
from ..auth import require_api_key
from ..normalize import to_event_dict
from ..schemas import AttackReplayResponse, EventIn, Explanation
from ..settings import get_settings
from .score import _score_events

router = APIRouter(tags=["investigate"], dependencies=[Depends(require_api_key)])


@router.post("/investigate", response_model=AttackReplayResponse)
async def investigate(
    request: Request,
    event: EventIn,
    sentinel_mode: bool = Query(
        default=True,
        description="Include Sentinel defensive response track in response",
    ),
) -> AttackReplayResponse:
    """AI Attack Replay & Next Attack Prediction.

    Accepts a cyber-domain security event, scores it with Cyber Watcher,
    reconstructs the attack timeline, identifies the current MITRE ATT&CK stage,
    predicts the most probable next attack stages with confidence scores, and
    returns a frontend-ready structured payload for animated attack replay.

    Requirements:
    - event_domain must be "cyber"
    - The event must score successfully
    """
    settings = get_settings()

    if event.event_domain != "cyber":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"The replay engine requires event_domain='cyber', "
                f"got '{event.event_domain}'. Use /score for other domains."
            ),
        )

    if not hasattr(request.app.state, "attack_replay_engine"):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Attack replay engine not initialised",
        )

    t0 = time.perf_counter()

    # Score event — always with explain enabled (replay requires SHAP evidence)
    if not settings.enable_explain:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="explain must be enabled (SENTINEL_ENABLE_EXPLAIN=true) for /investigate",
        )

    score_outs = await _score_events(
        request, [event], explain=True, include_graph=False, counterfactual=False
    )
    score_out = score_outs[0]

    if not score_out.scored:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Event could not be scored — check feature availability",
        )

    # Re-derive event_dict and explanation for engine
    ev_dict = to_event_dict(event)
    score_result: dict[str, Any] = {
        "risk_score": score_out.risk_score,
        "risk_level": score_out.risk_level,
        "model": score_out.model,
        "model_version": score_out.model_version,
        "scored": score_out.scored,
    }

    explanation: dict[str, Any] | None = None
    if score_out.explanation:
        explanation = {
            "model": score_out.explanation.model,
            "top_features": [
                {
                    "feature": f.feature,
                    "value": f.value,
                    "shap": f.shap,
                }
                for f in score_out.explanation.top_features
            ],
            "reasons": list(score_out.explanation.reasons),
        }

    replay_response = request.app.state.attack_replay_engine.investigate(
        event_dict=ev_dict,
        score_result=score_result,
        explanation=explanation,
        score_out=score_out,
        sentinel_mode=sentinel_mode,
    )

    metrics.SCORE_LATENCY.labels(endpoint="investigate").observe(time.perf_counter() - t0)
    return replay_response
