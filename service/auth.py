"""X-API-Key authentication dependency.

Keys come from settings (env-injected, never baked into the image). When
``require_auth`` is off (local/dev) the dependency is a no-op.
"""
from __future__ import annotations

from fastapi import Header, HTTPException, status

from .settings import Settings, get_settings


async def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    settings: Settings = get_settings()
    if not settings.require_auth:
        return
    valid = settings.api_key_set
    if not valid:
        # Fail closed: auth required but no keys configured is a misconfiguration.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="authentication not configured")
    if x_api_key is None or x_api_key not in valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing X-API-Key")
