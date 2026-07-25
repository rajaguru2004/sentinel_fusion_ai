"""API endpoints for Dynamic Threat Graph (AI Attack Relationship Visualization)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from ..auth import require_api_key
from ..graph.builder import ThreatGraphBuilder
from ..graph.models import ThreatGraphResponse
from ..normalize import to_event_dict
from ..schemas import EventIn

router = APIRouter(prefix="/graph", tags=["graph"], dependencies=[Depends(require_api_key)])


@router.post("/generate", response_model=ThreatGraphResponse)
async def generate_graph(
    request: Request,
    event: EventIn,
    incident_id: str | None = Query(default=None),
) -> ThreatGraphResponse:
    """Generate visual threat graph for a security event."""
    st = request.app.state
    ev_dict = to_event_dict(event)

    # Calculate score & feature attributions
    feat_results = await st.features.build_many([ev_dict])
    merged = [{**ev_dict, **feat_results[0][0]}]
    scored_rows = st.scorer.score(merged)
    score_res = scored_rows[0] if scored_rows else {}

    expl_raw = None
    if st.explainer and score_res.get("scored"):
        expl_raw = st.explainer.explain(merged[0])

    builder = ThreatGraphBuilder()
    graph = builder.build_graph(
        event=ev_dict,
        score_result=score_res,
        explanation=expl_raw,
        incident_id=incident_id,
    )

    # Persist in graph store
    if hasattr(st, "graph_store") and st.graph_store:
        await st.graph_store.save_graph(graph)

    return graph


@router.get("/incident/{incident_id}", response_model=ThreatGraphResponse)
async def get_incident_graph(
    request: Request,
    incident_id: str,
) -> ThreatGraphResponse:
    """Retrieve stored threat graph by incident ID."""
    st = request.app.state
    if hasattr(st, "graph_store") and st.graph_store:
        graph = await st.graph_store.get_graph(incident_id)
        if graph:
            return graph

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Threat graph for incident '{incident_id}' not found",
    )
