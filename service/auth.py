"""API-key authentication with per-client identity and rate limiting (§5.1).

v1 accepted a flat list of interchangeable keys, so every caller was anonymous
and indistinguishable: traffic could not be attributed, one client could not be
throttled without throttling all of them, and a leaked key could only be dealt
with by rotating everyone.

Keys are now **named**. `SENTINEL_API_KEYS` accepts either form:

    "k1,k2"                       -> legacy, clients named client-1, client-2
    "core-banking:k1,fraud-ops:k2"-> named clients

The client name is attached to the request, used as the rate-limit bucket, and
labels the request metrics, so a noisy or compromised integration is visible and
can be revoked on its own.

Keys are compared with `secrets.compare_digest` — a plain `in` test on a set is
not constant-time.
"""
from __future__ import annotations

import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from threading import Lock

from fastapi import Header, HTTPException, Request, status

from . import metrics
from .settings import Settings, get_settings


@dataclass
class _Bucket:
    """Sliding-window request log for one client."""
    hits: deque[float] = field(default_factory=deque)


class RateLimiter:
    """Fixed-cost sliding window, per client.

    A token bucket would smooth bursts better, but a sliding window is exact
    about "no more than N requests in the last 60s", which is what a rate limit
    is actually promised to enforce and what an operator can reason about.
    Bounded memory: the window is trimmed on every check.
    """

    def __init__(self, per_minute: int) -> None:
        self._per_minute = per_minute
        self._buckets: dict[str, _Bucket] = {}
        self._lock = Lock()

    def allow(self, client: str, now: float | None = None) -> tuple[bool, int]:
        """Return (allowed, retry_after_seconds)."""
        if self._per_minute <= 0:            # 0 disables limiting
            return True, 0
        now = time.monotonic() if now is None else now
        cutoff = now - 60.0
        with self._lock:
            b = self._buckets.setdefault(client, _Bucket())
            while b.hits and b.hits[0] < cutoff:
                b.hits.popleft()
            if len(b.hits) >= self._per_minute:
                return False, max(1, int(b.hits[0] + 60.0 - now) + 1)
            b.hits.append(now)
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


_limiter: RateLimiter | None = None


def get_limiter() -> RateLimiter:
    global _limiter
    if _limiter is None:
        _limiter = RateLimiter(get_settings().rate_limit_per_minute)
    return _limiter


def reset_limiter() -> None:
    """Test hook — also called when settings are reloaded."""
    global _limiter
    _limiter = None


def _match(presented: str, keys: dict[str, str]) -> str | None:
    """Constant-time lookup of a presented key. Returns the client name."""
    found = None
    for name, key in keys.items():
        # Compare against every key so timing does not reveal which one matched.
        if secrets.compare_digest(presented, key):
            found = name
    return found


async def require_api_key(request: Request,
                          x_api_key: str | None = Header(default=None)) -> str:
    """Authenticate, rate-limit, and attach the client identity to the request."""
    settings: Settings = get_settings()
    if not settings.require_auth:
        request.state.client = "anonymous"
        return "anonymous"

    keys = settings.api_key_map
    if not keys:
        # Fail closed: auth required but nothing configured is a misconfiguration.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="authentication not configured")
    if x_api_key is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="invalid or missing X-API-Key")
    client = _match(x_api_key, keys)
    if client is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="invalid or missing X-API-Key")

    allowed, retry_after = get_limiter().allow(client)
    if not allowed:
        metrics.RATE_LIMITED_TOTAL.labels(client=client).inc()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"rate limit exceeded for client '{client}'",
            headers={"Retry-After": str(retry_after)})

    request.state.client = client
    metrics.REQUESTS_TOTAL.labels(client=client,
                                  endpoint=request.url.path).inc()
    return client
