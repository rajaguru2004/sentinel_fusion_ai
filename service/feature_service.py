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

from .schemas import DegradedDetail
from .store import FeatureStore

# Bank-provided fallbacks (requirements §3.3). Precedence: a store-computed f_*
# wins whenever it is non-NaN; these seed the equivalent only when the store is
# cold or unreachable, so a first-ever payment still scores on real signal
# instead of all-NaN history.
_BANK_SEEDS = {
    "f_user_txn_count_1h": "bank_txn_count_1h",
    "f_amount_ratio_mean": "bank_amount_vs_user_mean",
    "f_counterparty_new": "bank_is_new_beneficiary",
}


def _is_nan(v: Any) -> bool:
    return v is None or (isinstance(v, float) and v != v)


class FeatureService:
    def __init__(self, store: FeatureStore, *, timeout_ms: int) -> None:
        self._store = store
        self._timeout = timeout_ms / 1000.0

    @staticmethod
    def _apply_bank_seeds(feats: dict[str, float], ev: Mapping[str, Any]) -> bool:
        """Fill store-derived gaps from the bank's own signals. Returns True if
        any seed was used (so the caller can report bank_context as the source)."""
        used = False
        for f_name, bank_name in _BANK_SEEDS.items():
            bank_val = ev.get(bank_name)
            if _is_nan(feats.get(f_name)) and not _is_nan(bank_val):
                feats[f_name] = float(bank_val)
                used = True
        return used

    async def build(self, ev: Mapping[str, Any],
                    *, advance: bool = True) -> tuple[dict[str, float], DegradedDetail]:
        """Return (engineered f_* features, per-group degradation detail).

        ``advance=False`` reads state without folding the event in — used by the
        replay path so a retried event_id never double-counts.
        """
        feats: dict[str, float] = dict(stateless_features(ev))
        has_user = ev.get("user_id") is not None
        has_device = ev.get("device_id") is not None
        try:
            call = (self._store.snapshot_and_advance(ev) if advance
                    else self._store.peek(ev))
            ust, ctx, dst = await asyncio.wait_for(call, self._timeout)
        except Exception:  # any store fault (timeout, connection) -> graceful degrade
            seeded = self._apply_bank_seeds(feats, ev)
            return feats, DegradedDetail(
                degraded=True, store_unavailable=True,
                user_history=has_user, device_history=has_device,
                bank_context_used=seeded)
        if ust is not None:
            feats.update(user_features(
                ust, ev,
                seen_country=ctx.seen_country,
                seen_counterparty=ctx.seen_counterparty,
                n_counterparties=ctx.n_counterparties,
                seen_merchant_category=ctx.seen_merchant_category,
                txn_count_window=ctx.txn_count_window))
        if dst is not None:
            feats.update(device_features(dst))
        seeded = self._apply_bank_seeds(feats, ev)
        # A user with no prior events is "cold", not broken -- report it so the
        # bank can tell "no history yet" apart from "store was down".
        cold_user = has_user and (ust is None or ust.seq == 0)
        detail = DegradedDetail(
            degraded=bool(cold_user or (has_user and ust is None)
                          or (has_device and dst is None)),
            store_unavailable=False,
            user_history=has_user and (ust is None or ust.seq == 0),
            device_history=has_device and dst is None,
            bank_context_used=seeded)
        return feats, detail

    async def build_many(
            self, events: list[Mapping[str, Any]]
    ) -> list[tuple[dict[str, float], DegradedDetail]]:
        order = sorted(range(len(events)),
                       key=lambda i: (str(events[i].get("user_id") or ""),
                                      pd.Timestamp(events[i]["event_time"]),
                                      str(events[i].get("event_id") or "")))
        out: list[tuple[dict[str, float], DegradedDetail] | None] = [None] * len(events)
        for i in order:
            out[i] = await self.build(events[i])
        return out  # type: ignore[return-value]
