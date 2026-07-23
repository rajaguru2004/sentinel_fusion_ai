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
import time
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


class _Breaker:
    """Circuit breaker around the feature store (§5.2).

    Without it, a dead store costs EVERY request the full `store_timeout_ms`
    before degrading — the p99 blows out precisely when the store is unhealthy,
    which is the worst possible moment on the money path. After
    `fail_threshold` consecutive faults the circuit opens and calls degrade
    instantly; after `reset_s` one probe is allowed through to re-close it.
    """

    def __init__(self, fail_threshold: int, reset_s: float) -> None:
        self._threshold = max(1, fail_threshold)
        self._reset_s = reset_s
        self._fails = 0
        self._opened_at: float | None = None

    @property
    def is_open(self) -> bool:
        if self._opened_at is None:
            return False
        if time.monotonic() - self._opened_at >= self._reset_s:
            self._opened_at = None       # half-open: let one probe through
            self._fails = 0
            return False
        return True

    def record_success(self) -> None:
        self._fails = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._fails += 1
        if self._fails >= self._threshold and self._opened_at is None:
            self._opened_at = time.monotonic()

    @property
    def state(self) -> str:
        return "open" if self.is_open else ("degraded" if self._fails else "closed")


class FeatureService:
    def __init__(self, store: FeatureStore, *, timeout_ms: int,
                 breaker_fail_threshold: int = 5,
                 breaker_reset_s: float = 10.0) -> None:
        self._store = store
        self._timeout = timeout_ms / 1000.0
        self._breaker = _Breaker(breaker_fail_threshold, breaker_reset_s)

    @property
    def breaker_state(self) -> str:
        return self._breaker.state

    @staticmethod
    def _apply_bank_seeds(feats: dict[str, float], ev: Mapping[str, Any],
                          *, cold: bool = False) -> bool:
        """Fill store-derived gaps from the bank's own signals.

        ``cold`` = the store holds no history for this entity. That matters
        because a brand-new customer yields `f_user_txn_count_1h = 0` and
        `f_counterparty_new = 1` — *numbers*, not NaN — so a NaN-only rule would
        never seed, and the bank's `txnCountLastHour: 9` would be silently
        discarded on exactly the events where it is the only signal available.
        A store value of 0 for an entity it has never seen is absence of
        knowledge, not knowledge; the bank's view wins there.

        Returns True if any seed was used.
        """
        used = False
        for f_name, bank_name in _BANK_SEEDS.items():
            bank_val = ev.get(bank_name)
            if _is_nan(bank_val):
                continue
            if _is_nan(feats.get(f_name)) or cold:
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

        def _degrade() -> tuple[dict[str, float], DegradedDetail]:
            seeded = self._apply_bank_seeds(feats, ev, cold=True)
            return feats, DegradedDetail(
                degraded=True, store_unavailable=True,
                user_history=has_user, device_history=has_device,
                bank_context_used=seeded)

        if self._breaker.is_open:
            # Skip the call entirely — paying the timeout on every request while
            # the store is known-down is what breaks the latency SLA.
            return _degrade()
        try:
            call = (self._store.snapshot_and_advance(ev) if advance
                    else self._store.peek(ev))
            ust, ctx, dst = await asyncio.wait_for(call, self._timeout)
        except Exception:  # any store fault (timeout, connection) -> graceful degrade
            self._breaker.record_failure()
            return _degrade()
        self._breaker.record_success()
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
        # A user with no prior events is "cold", not broken -- report it so the
        # bank can tell "no history yet" apart from "store was down".
        cold_user = has_user and (ust is None or ust.seq == 0)
        seeded = self._apply_bank_seeds(feats, ev, cold=cold_user)
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
