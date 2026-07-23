"""Runtime configuration — environment-driven, 12-factor style.

All values come from env vars (prefix ``SENTINEL_``) or a ``.env`` file, so the
same image runs in every environment with no code change. API keys never live
in the image; inject them at deploy time.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

from ml.config import MODELS


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SENTINEL_", env_file=".env", extra="ignore")

    # --- model artifacts ---
    models_dir: Path = MODELS
    model_version: str = "dev"

    # --- auth ---
    # Comma-separated, optionally NAMED so traffic is attributable and a single
    # client can be throttled or revoked on its own (§5.1):
    #   "k1,k2"                          -> client-1, client-2
    #   "core-banking:k1,fraud-ops:k2"   -> named clients
    # Demo default so the service runs out of the box; OVERRIDE in production.
    api_keys: str = "sentinel-demo-key-2026"
    require_auth: bool = False
    # Requests per minute per CLIENT (not global). 0 disables limiting.
    rate_limit_per_minute: int = 0

    # --- feature store ---
    redis_url: str | None = None            # None -> in-memory store (dev/tests)
    state_ttl_seconds: int = 90 * 24 * 3600  # sliding retention per entity
    store_timeout_ms: int = 50               # per-request store budget

    # --- request limits ---
    max_batch: int = 1000

    # --- explainability ---
    enable_explain: bool = True              # allow ?explain=true (needs shap)
    explain_top_k: int = 7

    # --- operational ---
    reject_future_events_seconds: int = 300  # guard against bad/replayed clocks

    # --- feature-store circuit breaker (§5.2) ---
    # After N consecutive store faults, stop calling it for `breaker_reset_s`
    # and degrade immediately. Without this, a dead store costs every request
    # the full store timeout before degrading — which is how a slow dependency
    # turns into a breached latency SLA on the money path.
    breaker_fail_threshold: int = 5
    breaker_reset_s: float = 10.0

    @property
    def api_key_map(self) -> dict[str, str]:
        """client name -> key. Unnamed entries get a positional name."""
        out: dict[str, str] = {}
        for i, raw in enumerate(self.api_keys.split(","), start=1):
            entry = raw.strip()
            if not entry:
                continue
            # rsplit: a key may itself contain ':' , the NAME may not.
            if ":" in entry:
                name, key = entry.split(":", 1)
                name, key = name.strip(), key.strip()
            else:
                name, key = f"client-{i}", entry
            if key:
                out[name] = key
        return out

    @property
    def api_key_set(self) -> frozenset[str]:
        return frozenset(self.api_key_map.values())


@lru_cache
def get_settings() -> Settings:
    return Settings()
