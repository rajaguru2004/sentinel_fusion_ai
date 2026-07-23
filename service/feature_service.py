"""Bridge between the feature store and the scorer.

For each event: compute the stateless features locally, fetch+advance the
per-entity state (bounded by a timeout so a slow/dead store degrades rather than
hangs), and merge in the stateful features. On store failure the stateful ``f_*``
are simply omitted — they become NaN in the model matrix, which is GBM-safe, and
the response is flagged ``degraded``.

Batch ordering: events for the same user must advance state in time order, so a
batch is processed sorted by ``(user_id, event_time, event_id)`` and the results
are restored to the caller's original order.
"""
from __future__ import annotations

import asyncio
from typing import Any, Mapping

import pandas as pd

from ml.feature_core import device_features, stateless_features, user_features

from .store import FeatureStore


class FeatureService:
    def __init__(self, store: FeatureStore, *, timeout_ms: int) -> None:
        self._store = store
        self._timeout = timeout_ms / 1000.0

    async def build(self, ev: Mapping[str, Any]) -> tuple[dict[str, float], bool]:
        """Return (engineered f_* features, degraded)."""
        feats: dict[str, float] = dict(stateless_features(ev))
        try:
            ust, seen, dst = await asyncio.wait_for(
                self._store.snapshot_and_advance(ev), self._timeout)
        except Exception:  # any store fault (timeout, connection) -> graceful degrade
            return feats, True
        if ust is not None:
            feats.update(user_features(ust, ev, seen_country=seen))
        if dst is not None:
            feats.update(device_features(dst))
        return feats, False

    async def build_many(
            self, events: list[Mapping[str, Any]]) -> list[tuple[dict[str, float], bool]]:
        order = sorted(range(len(events)),
                       key=lambda i: (str(events[i].get("user_id") or ""),
                                      pd.Timestamp(events[i]["event_time"]),
                                      str(events[i].get("event_id") or "")))
        out: list[tuple[dict[str, float], bool] | None] = [None] * len(events)
        for i in order:
            out[i] = await self.build(events[i])
        return out  # type: ignore[return-value]
