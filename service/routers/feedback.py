"""Feedback endpoints — record confirmed outcomes (requirements §5.3).

The bank posts the adjudicated outcome of an event (chargeback, SOC review) and
the user's malicious counter is incremented, idempotent per `event_id`.

**Scope note.** `f_user_past_malicious_rate` — the feature this loop feeds — is
currently NOT an input to `fraud_payment` or `behaviour`. It was removed because
it is built offline from instantly-known labels but arrives here days late and
incompletely: 54% of training rows had it non-zero versus 0% of live traffic,
and the models had learned "rate == 0 means benign", suppressing real fraud
scores to ~0. See `ml/feature_spec.py::USER_F_SERVABLE`.

The loop is still worth running: the counters accumulate now, so once FinSpark
supplies `label.confirmedAt` (docs/finspark_export_spec.md) and the offline
builder replays labels at their true confirmation time, the feature can be
restored with matching train/serve distributions instead of starting cold.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status

from .. import metrics
from ..auth import require_api_key
from ..schemas import FeedbackBatchIn, FeedbackBatchOut, FeedbackIn, FeedbackOut
from ..settings import get_settings

router = APIRouter(tags=["feedback"], dependencies=[Depends(require_api_key)])


@router.post("/feedback", response_model=FeedbackOut)
async def feedback(request: Request, body: FeedbackIn) -> FeedbackOut:
    applied = await request.app.state.store.feedback(
        body.user_id, body.event_id, body.label)
    metrics.FEEDBACK_TOTAL.labels(applied=str(applied).lower()).inc()
    return FeedbackOut(event_id=body.event_id, applied=applied)


@router.post("/feedback/batch", response_model=FeedbackBatchOut)
async def feedback_batch(request: Request,
                         body: FeedbackBatchIn) -> FeedbackBatchOut:
    """Bulk backfill (§5.3). Idempotent per event_id, so replaying a whole
    adjudication export is safe."""
    settings = get_settings()
    if len(body.items) > settings.max_batch:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"batch exceeds max_batch={settings.max_batch}")
    store = request.app.state.store
    results = []
    for item in body.items:
        applied = await store.feedback(item.user_id, item.event_id, item.label)
        metrics.FEEDBACK_TOTAL.labels(applied=str(applied).lower()).inc()
        results.append(FeedbackOut(event_id=item.event_id, applied=applied))
    return FeedbackBatchOut(results=results,
                            applied=sum(1 for r in results if r.applied),
                            duplicates=sum(1 for r in results if not r.applied))
