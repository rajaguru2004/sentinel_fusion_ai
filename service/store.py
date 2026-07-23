"""Online feature store — per-user / per-device running aggregates.

Two backends behind one Protocol:

* :class:`InMemoryStore` — process-local dicts + a lock; for dev, tests, and
  single-worker runs. Not shared across workers.
* :class:`RedisFeatureStore` — durable, shared, horizontally-scalable. The
  read→advance critical section runs as a single Redis Lua script per entity so
  concurrent events for the same user/device are serialised (no lost updates on
  ``secs_since_last`` / amount moments / new-country).

The store only moves *counters*; all feature arithmetic lives in
:mod:`ml.feature_core` so there is exactly one source of feature semantics. Each
call returns the entity state as it was BEFORE the event (past-only), then folds
the event in.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any, Mapping, Protocol

from ml.feature_core import (
    DeviceState,
    UserState,
    advance_device,
    advance_user,
    is_high_severity,
)

Snapshot = tuple[UserState | None, bool, DeviceState | None]


def _entity_id(ev: Mapping[str, Any], key: str) -> str | None:
    v = ev.get(key)
    if v is None:
        return None
    s = str(v)
    return s if s and s.lower() != "nan" else None


class FeatureStore(Protocol):
    async def ping(self) -> bool: ...
    async def snapshot_and_advance(self, ev: Mapping[str, Any]) -> Snapshot: ...
    async def feedback(self, user_id: str, event_id: str, label: int) -> bool: ...
    async def close(self) -> None: ...


# ---------------------------------------------------------------- in-memory ---
class InMemoryStore:
    def __init__(self) -> None:
        self._users: dict[str, UserState] = {}
        self._devices: dict[str, DeviceState] = {}
        self._countries: dict[str, set[str]] = {}
        self._ledger: set[str] = set()          # feedback event_ids (idempotency)
        self._lock = asyncio.Lock()

    async def ping(self) -> bool:
        return True

    async def snapshot_and_advance(self, ev: Mapping[str, Any]) -> Snapshot:
        uid = _entity_id(ev, "user_id")
        did = _entity_id(ev, "device_id")
        country = ev.get("country")
        has_country = country is not None and str(country).lower() != "nan"
        async with self._lock:
            ust = seen = dst = None
            if uid is not None:
                ust = self._users.get(uid, UserState())
                seen = bool(has_country and country in self._countries.get(uid, set()))
                self._users[uid] = advance_user(ust, ev)
                if has_country:
                    self._countries.setdefault(uid, set()).add(country)
            if did is not None:
                dst = self._devices.get(did, DeviceState())
                self._devices[did] = advance_device(dst, ev)
            return ust, bool(seen), dst

    async def feedback(self, user_id: str, event_id: str, label: int) -> bool:
        async with self._lock:
            if event_id in self._ledger:
                return False
            self._ledger.add(event_id)
            if label == 1:
                st = self._users.get(user_id, UserState())
                self._users[user_id] = replace(st, pos=st.pos + 1)
            return True

    async def close(self) -> None:
        return None


# -------------------------------------------------------------------- redis ---
_USER_LUA = """
local h = KEYS[1]
local o = redis.call('HMGET', h, 'seq','last_ts','amt_n','amt_sum','amt_sumsq','pos')
local seen = 0
if ARGV[5] == '1' then
  if redis.call('SISMEMBER', KEYS[2], ARGV[6]) == 1 then seen = 1 end
end
redis.call('HINCRBY', h, 'seq', 1)
redis.call('HSET', h, 'last_ts', ARGV[1])
if ARGV[2] == '1' then
  redis.call('HINCRBY', h, 'amt_n', 1)
  redis.call('HINCRBYFLOAT', h, 'amt_sum', ARGV[3])
  redis.call('HINCRBYFLOAT', h, 'amt_sumsq', ARGV[4])
end
if ARGV[5] == '1' then
  redis.call('SADD', KEYS[2], ARGV[6])
  redis.call('EXPIRE', KEYS[2], ARGV[7])
end
redis.call('EXPIRE', h, ARGV[7])
return {o[1], o[2], o[3], o[4], o[5], o[6], seen}
"""

_DEVICE_LUA = """
local h = KEYS[1]
local o = redis.call('HMGET', h, 'seq','hisev')
redis.call('HINCRBY', h, 'seq', 1)
if ARGV[1] == '1' then redis.call('HINCRBY', h, 'hisev', 1) end
redis.call('EXPIRE', h, ARGV[2])
return {o[1], o[2]}
"""

_FEEDBACK_LUA = """
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return 0 end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[3])
if ARGV[2] == '1' then redis.call('HINCRBY', KEYS[1], 'pos', 1) end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
"""


def _f(v: Any, default: float = 0.0) -> float:
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _i(v: Any, default: int = 0) -> int:
    if v is None:
        return default
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


class RedisFeatureStore:
    """Hash-tagged keys so a user's hash + country set live in one slot (cluster-safe)."""

    def __init__(self, client: Any, *, ttl: int) -> None:
        self._r = client
        self._ttl = ttl
        self._user = self._r.register_script(_USER_LUA)
        self._device = self._r.register_script(_DEVICE_LUA)
        self._fb = self._r.register_script(_FEEDBACK_LUA)

    @staticmethod
    def _uh(uid: str) -> str:
        return f"feat:u:{{{uid}}}"

    @staticmethod
    def _uc(uid: str) -> str:
        return f"feat:u:{{{uid}}}:cty"

    @staticmethod
    def _uledger(uid: str) -> str:
        return f"feat:u:{{{uid}}}:fb"

    @staticmethod
    def _dh(did: str) -> str:
        return f"feat:d:{did}"

    async def ping(self) -> bool:
        return bool(await self._r.ping())

    async def snapshot_and_advance(self, ev: Mapping[str, Any]) -> Snapshot:
        uid = _entity_id(ev, "user_id")
        did = _entity_id(ev, "device_id")
        ust = seen = dst = None

        if uid is not None:
            amount = ev.get("amount")
            has_amt = amount is not None and str(amount).lower() != "nan"
            amt = _f(amount)
            country = ev.get("country")
            has_country = country is not None and str(country).lower() != "nan"
            now = _event_epoch(ev)
            res = await self._user(
                keys=[self._uh(uid), self._uc(uid)],
                args=[now, "1" if has_amt else "0", amt, amt * amt,
                      "1" if has_country else "0",
                      str(country) if has_country else "", self._ttl])
            ust = UserState(
                seq=_i(res[0]), last_ts=(None if res[1] is None else _f(res[1])),
                amt_n=_i(res[2]), amt_sum=_f(res[3]), amt_sumsq=_f(res[4]),
                pos=_i(res[5]))
            seen = bool(_i(res[6]))

        if did is not None:
            res = await self._device(
                keys=[self._dh(did)],
                args=["1" if is_high_severity(ev) else "0", self._ttl])
            dst = DeviceState(seq=_i(res[0]), hisev=_i(res[1]))

        return ust, bool(seen), dst

    async def feedback(self, user_id: str, event_id: str, label: int) -> bool:
        res = await self._fb(
            keys=[self._uh(user_id), self._uledger(user_id)],
            args=[event_id, "1" if label == 1 else "0", self._ttl])
        return bool(_i(res))

    async def close(self) -> None:
        await self._r.aclose()


def _event_epoch(ev: Mapping[str, Any]) -> float:
    import pandas as pd
    return float(pd.Timestamp(ev["event_time"]).timestamp())
