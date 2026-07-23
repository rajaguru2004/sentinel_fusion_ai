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
import json
from dataclasses import dataclass, replace
from typing import Any, Mapping, Protocol

from ml.feature_core import (
    DeviceState,
    UserState,
    advance_device,
    advance_user,
    is_high_severity,
)
from ml.feature_spec import TXN_WINDOW_S


@dataclass(frozen=True)
class UserContext:
    """Set-membership + windowed counts the store owns for a user.

    These live here rather than on :class:`UserState` for the same reason
    ``seen_country`` always has: scalar counters fit an entity hash, whereas set
    membership needs a Redis SET and a sliding window needs a ZSET. All values
    are PRE-event, matching the past-only rule in ``ml.feature_core``.
    """
    seen_country: bool = False
    seen_counterparty: bool = False
    n_counterparties: int = 0
    seen_merchant_category: bool = False
    txn_count_window: int = 0


Snapshot = tuple[UserState | None, UserContext, DeviceState | None]


# Placeholder written when an event_id is first claimed, replaced by the encoded
# snapshot once the winner has computed it.
_PENDING = "1"


def _encode_snapshot(snap: Snapshot) -> str:
    ust, ctx, dst = snap
    return json.dumps({
        "u": None if ust is None else [ust.seq, ust.last_ts, ust.amt_n,
                                       ust.amt_sum, ust.amt_sumsq, ust.pos],
        "c": [ctx.seen_country, ctx.seen_counterparty, ctx.n_counterparties,
              ctx.seen_merchant_category, ctx.txn_count_window],
        "d": None if dst is None else [dst.seq, dst.hisev],
    }, separators=(",", ":"))


def _decode_snapshot(blob: str) -> Snapshot | None:
    """Rebuild a snapshot written by a previous call; None if not one."""
    if not blob or blob == _PENDING:
        return None
    try:
        d = json.loads(blob)
        u, c, dv = d["u"], d["c"], d["d"]
    except (ValueError, KeyError, TypeError):
        return None
    ust = None if u is None else UserState(seq=u[0], last_ts=u[1], amt_n=u[2],
                                           amt_sum=u[3], amt_sumsq=u[4], pos=u[5])
    dst = None if dv is None else DeviceState(seq=dv[0], hisev=dv[1])
    return ust, UserContext(*c), dst


def _present(v: Any) -> bool:
    """Non-null by the same rule the offline path uses.

    Not just `is not None`: values arriving from pandas/`iterrows()` carry `nan`
    for absent object cells, and treating those as present makes the online
    features diverge from `engineer_batch` on exactly those rows.
    """
    return v is not None and str(v).lower() != "nan"


def _entity_id(ev: Mapping[str, Any], key: str) -> str | None:
    v = ev.get(key)
    if v is None:
        return None
    s = str(v)
    return s if s and s.lower() != "nan" else None


class FeatureStore(Protocol):
    async def ping(self) -> bool: ...
    async def snapshot_and_advance(self, ev: Mapping[str, Any]) -> Snapshot: ...
    async def peek(self, ev: Mapping[str, Any]) -> Snapshot: ...
    async def feedback(self, user_id: str, event_id: str, label: int) -> bool: ...
    async def close(self) -> None: ...


# ---------------------------------------------------------------- in-memory ---
class InMemoryStore:
    def __init__(self) -> None:
        self._users: dict[str, UserState] = {}
        self._devices: dict[str, DeviceState] = {}
        self._countries: dict[str, set[str]] = {}
        self._counterparties: dict[str, set[str]] = {}
        self._mccs: dict[str, set[str]] = {}
        self._window: dict[str, list[float]] = {}   # recent event epochs per user
        self._ledger: set[str] = set()          # feedback event_ids (idempotency)
        self._seen_events: dict[str, Snapshot] = {}  # /score + /ingest idempotency
        self._lock = asyncio.Lock()

    async def ping(self) -> bool:
        return True

    async def snapshot_and_advance(self, ev: Mapping[str, Any]) -> Snapshot:
        uid = _entity_id(ev, "user_id")
        did = _entity_id(ev, "device_id")
        eid = _entity_id(ev, "event_id")
        country, cp = ev.get("country"), ev.get("counterparty_id")
        mcc = ev.get("merchant_category")
        has_country, has_cp, has_mcc = _present(country), _present(cp), _present(mcc)
        now = _event_epoch(ev)

        async with self._lock:
            # §3.2 idempotency: a retried event_id must return the SAME features
            # and advance counters exactly once. Without this a network retry
            # double-counts velocity and corrupts every later score for the user.
            if eid is not None and eid in self._seen_events:
                return self._seen_events[eid]

            ust, dst = None, None
            ctx = UserContext()
            if uid is not None:
                ust = self._users.get(uid, UserState())
                recent = self._window.setdefault(uid, [])
                cutoff = now - TXN_WINDOW_S
                ctx = UserContext(
                    seen_country=bool(has_country and country in self._countries.get(uid, set())),
                    seen_counterparty=bool(has_cp and cp in self._counterparties.get(uid, set())),
                    n_counterparties=len(self._counterparties.get(uid, set())),
                    seen_merchant_category=bool(has_mcc and mcc in self._mccs.get(uid, set())),
                    txn_count_window=sum(1 for t in recent if t >= cutoff),
                )
                self._users[uid] = advance_user(ust, ev)
                if has_country:
                    self._countries.setdefault(uid, set()).add(country)
                if has_cp:
                    self._counterparties.setdefault(uid, set()).add(cp)
                if has_mcc:
                    self._mccs.setdefault(uid, set()).add(mcc)
                # Keep the window bounded: drop expired entries as we append.
                recent[:] = [t for t in recent if t >= cutoff]
                recent.append(now)
            if did is not None:
                dst = self._devices.get(did, DeviceState())
                self._devices[did] = advance_device(dst, ev)

            snap = (ust, ctx, dst)
            if eid is not None:
                self._seen_events[eid] = snap
            return snap

    async def peek(self, ev: Mapping[str, Any]) -> Snapshot:
        """Replay path: return the snapshot recorded for this event_id."""
        eid = _entity_id(ev, "event_id")
        async with self._lock:
            if eid is not None and eid in self._seen_events:
                return self._seen_events[eid]
        return None, UserContext(), None

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
# KEYS 1=user hash 2=country set 3=counterparty set 4=mcc set 5=velocity zset
# ARGV 1=now 2=has_amt 3=amt 4=amt^2 5=has_country 6=country 7=ttl
#      8=has_cp 9=counterparty 10=has_mcc 11=mcc 12=window_start
# Whole read->advance runs as one script so concurrent events for the same user
# serialise (no lost updates on secs_since_last / moments / set membership).
_USER_LUA = """
local h = KEYS[1]
local o = redis.call('HMGET', h, 'seq','last_ts','amt_n','amt_sum','amt_sumsq','pos')
local seen_c, seen_cp, seen_mcc = 0, 0, 0
if ARGV[5] == '1' and redis.call('SISMEMBER', KEYS[2], ARGV[6]) == 1 then seen_c = 1 end
if ARGV[8] == '1' and redis.call('SISMEMBER', KEYS[3], ARGV[9]) == 1 then seen_cp = 1 end
if ARGV[10] == '1' and redis.call('SISMEMBER', KEYS[4], ARGV[11]) == 1 then seen_mcc = 1 end
local n_cp = redis.call('SCARD', KEYS[3])
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', '(' .. ARGV[12])
local win = redis.call('ZCARD', KEYS[5])

redis.call('HINCRBY', h, 'seq', 1)
redis.call('HSET', h, 'last_ts', ARGV[1])
if ARGV[2] == '1' then
  redis.call('HINCRBY', h, 'amt_n', 1)
  redis.call('HINCRBYFLOAT', h, 'amt_sum', ARGV[3])
  redis.call('HINCRBYFLOAT', h, 'amt_sumsq', ARGV[4])
end
if ARGV[5] == '1' then
  redis.call('SADD', KEYS[2], ARGV[6]); redis.call('EXPIRE', KEYS[2], ARGV[7])
end
if ARGV[8] == '1' then
  redis.call('SADD', KEYS[3], ARGV[9]); redis.call('EXPIRE', KEYS[3], ARGV[7])
end
if ARGV[10] == '1' then
  redis.call('SADD', KEYS[4], ARGV[11]); redis.call('EXPIRE', KEYS[4], ARGV[7])
end
-- member is unique per event so retries cannot inflate the window
redis.call('ZADD', KEYS[5], ARGV[1], ARGV[13])
redis.call('EXPIRE', KEYS[5], ARGV[7])
redis.call('EXPIRE', h, ARGV[7])
return {o[1], o[2], o[3], o[4], o[5], o[6], seen_c, seen_cp, n_cp, seen_mcc, win}
"""

_DEVICE_LUA = """
local h = KEYS[1]
local o = redis.call('HMGET', h, 'seq','hisev')
redis.call('HINCRBY', h, 'seq', 1)
if ARGV[1] == '1' then redis.call('HINCRBY', h, 'hisev', 1) end
redis.call('EXPIRE', h, ARGV[2])
return {o[1], o[2]}
"""

# §3.2 idempotency. SET NX on the event_id: the first caller wins and advances
# state; a replay loses the claim and reads back the snapshot the winner stored,
# so it returns byte-identical features. TTL-bounded like the feedback ledger so
# the keyspace stays finite.
#
# Returns the stored snapshot on a replay (or the "1" placeholder if the winner
# has not finished writing it yet).
_CLAIM_LUA = """
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then return '' end
return redis.call('GET', KEYS[1])
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
        self._claim = self._r.register_script(_CLAIM_LUA)

    @staticmethod
    def _uh(uid: str) -> str:
        return f"feat:u:{{{uid}}}"

    @staticmethod
    def _uc(uid: str) -> str:
        return f"feat:u:{{{uid}}}:cty"

    @staticmethod
    def _ucp(uid: str) -> str:
        return f"feat:u:{{{uid}}}:cp"

    @staticmethod
    def _umcc(uid: str) -> str:
        return f"feat:u:{{{uid}}}:mcc"

    @staticmethod
    def _uwin(uid: str) -> str:
        return f"feat:u:{{{uid}}}:win"

    @staticmethod
    def _evt(eid: str) -> str:
        return f"feat:evt:{eid}"

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
        eid = _entity_id(ev, "event_id")
        ust, dst = None, None
        ctx = UserContext()

        # §3.2: claim the event_id before touching any counter. A replay loses
        # the claim and returns the winner's stored snapshot, so retries cannot
        # double-count velocity / amount moments / device history AND get
        # byte-identical features back.
        if eid is not None:
            prior = await self._claim(keys=[self._evt(eid)],
                                      args=[_PENDING, self._ttl])
            prior = prior.decode() if isinstance(prior, bytes) else prior
            if prior:                       # lost the claim -> this is a replay
                cached = _decode_snapshot(prior)
                if cached is not None:
                    return cached
                # Winner is still mid-flight (placeholder only). Reading live
                # state would double-count nothing but could disagree with what
                # the winner returns, so approximate from current state.
                return await self.peek(ev)

        if uid is not None:
            amount = ev.get("amount")
            has_amt = _present(amount)
            amt = _f(amount)
            country, cp = ev.get("country"), ev.get("counterparty_id")
            mcc = ev.get("merchant_category")
            has_country, has_cp, has_mcc = _present(country), _present(cp), _present(mcc)
            now = _event_epoch(ev)
            res = await self._user(
                keys=[self._uh(uid), self._uc(uid), self._ucp(uid),
                      self._umcc(uid), self._uwin(uid)],
                args=[now, "1" if has_amt else "0", amt, amt * amt,
                      "1" if has_country else "0",
                      str(country) if has_country else "", self._ttl,
                      "1" if has_cp else "0", str(cp) if has_cp else "",
                      "1" if has_mcc else "0", str(mcc) if has_mcc else "",
                      now - TXN_WINDOW_S, eid or f"{now}"])
            ust = UserState(
                seq=_i(res[0]), last_ts=(None if res[1] is None else _f(res[1])),
                amt_n=_i(res[2]), amt_sum=_f(res[3]), amt_sumsq=_f(res[4]),
                pos=_i(res[5]))
            ctx = UserContext(
                seen_country=bool(_i(res[6])), seen_counterparty=bool(_i(res[7])),
                n_counterparties=_i(res[8]), seen_merchant_category=bool(_i(res[9])),
                txn_count_window=_i(res[10]))

        if did is not None:
            res = await self._device(
                keys=[self._dh(did)],
                args=["1" if is_high_severity(ev) else "0", self._ttl])
            dst = DeviceState(seq=_i(res[0]), hisev=_i(res[1]))

        snap = (ust, ctx, dst)
        if eid is not None:
            # Store what we returned so a replay is byte-identical rather than
            # an approximation reconstructed from post-advance counters.
            await self._r.set(self._evt(eid), _encode_snapshot(snap),
                              ex=self._ttl)
        return snap

    async def peek(self, ev: Mapping[str, Any]) -> Snapshot:
        """Read entity state WITHOUT advancing it (approximate replay path).

        Returns current state rather than the exact bytes returned first time.
        For a same-instant retry these coincide; if other events for the entity
        landed in between, the replay sees fresher history. That is the safe
        direction — the invariant the bank needs is that counters advance once,
        not that a stale response is reproduced forever.
        """
        uid = _entity_id(ev, "user_id")
        did = _entity_id(ev, "device_id")
        ust, dst = None, None
        ctx = UserContext()
        if uid is not None:
            h = await self._r.hmget(self._uh(uid), "seq", "last_ts", "amt_n",
                                    "amt_sum", "amt_sumsq", "pos")
            ust = UserState(seq=max(_i(h[0]) - 1, 0),
                            last_ts=(None if h[1] is None else _f(h[1])),
                            amt_n=_i(h[2]), amt_sum=_f(h[3]),
                            amt_sumsq=_f(h[4]), pos=_i(h[5]))
            country, cp = ev.get("country"), ev.get("counterparty_id")
            mcc = ev.get("merchant_category")
            ctx = UserContext(
                seen_country=bool(_present(country) and await self._r.sismember(
                    self._uc(uid), str(country))),
                seen_counterparty=bool(_present(cp) and await self._r.sismember(
                    self._ucp(uid), str(cp))),
                n_counterparties=int(await self._r.scard(self._ucp(uid))),
                seen_merchant_category=bool(_present(mcc) and await self._r.sismember(
                    self._umcc(uid), str(mcc))),
                txn_count_window=int(await self._r.zcount(
                    self._uwin(uid), _event_epoch(ev) - TXN_WINDOW_S, "+inf")),
            )
        if did is not None:
            d = await self._r.hmget(self._dh(did), "seq", "hisev")
            dst = DeviceState(seq=max(_i(d[0]) - 1, 0), hisev=_i(d[1]))
        return ust, ctx, dst

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
