"""In-memory and Redis threat graph caching store."""
from __future__ import annotations

import json
from typing import Any, Protocol

from .models import ThreatGraphResponse


class ThreatGraphStore(Protocol):
    """Abstract interface for threat graph storage."""

    async def get_graph(self, incident_id: str) -> ThreatGraphResponse | None:
        ...

    async def save_graph(self, graph: ThreatGraphResponse, ttl_s: int = 86400) -> None:
        ...


class InMemoryThreatGraphStore:
    """In-memory graph store for dev/testing."""

    def __init__(self) -> None:
        self._graphs: dict[str, str] = {}

    async def get_graph(self, incident_id: str) -> ThreatGraphResponse | None:
        raw = self._graphs.get(incident_id)
        if not raw:
            return None
        return ThreatGraphResponse.model_validate_json(raw)

    async def save_graph(self, graph: ThreatGraphResponse, ttl_s: int = 86400) -> None:
        self._graphs[graph.incident_id] = graph.model_dump_json()


class RedisThreatGraphStore:
    """Redis-backed shared threat graph store."""

    def __init__(self, redis_client: Any) -> None:
        self._client = redis_client

    async def get_graph(self, incident_id: str) -> ThreatGraphResponse | None:
        key = f"sentinel:graph:{incident_id}"
        raw = await self._client.get(key)
        if not raw:
            return None
        return ThreatGraphResponse.model_validate_json(raw)

    async def save_graph(self, graph: ThreatGraphResponse, ttl_s: int = 86400) -> None:
        key = f"sentinel:graph:{graph.incident_id}"
        await self._client.set(key, graph.model_dump_json(), ex=ttl_s)
