"""Feedback endpoint — closes the label loop for f_user_past_malicious_rate.

The bank posts the confirmed outcome of an event; the user's malicious counter
is incremented (idempotent per event_id). See ml.feature_core module docstring
for the labeling-delay skew this addresses.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from .. import metrics
from ..auth import require_api_key
from ..schemas import FeedbackIn, FeedbackOut

router = APIRouter(tags=["feedback"], dependencies=[Depends(require_api_key)])


@router.post("/feedback", response_model=FeedbackOut)
async def feedback(request: Request, body: FeedbackIn) -> FeedbackOut:
    applied = await request.app.state.store.feedback(
        body.user_id, body.event_id, body.label)
    metrics.FEEDBACK_TOTAL.labels(applied=str(applied).lower()).inc()
    return FeedbackOut(event_id=body.event_id, applied=applied)
