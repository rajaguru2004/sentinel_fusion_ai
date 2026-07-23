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

    # --- auth: comma-separated keys, e.g. SENTINEL_API_KEYS="k1,k2" ---
    # Demo default so the service runs out of the box; OVERRIDE in production.
    api_keys: str = "sentinel-demo-key-2026"
    require_auth: bool = True

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

    @property
    def api_key_set(self) -> frozenset[str]:
        return frozenset(k.strip() for k in self.api_keys.split(",") if k.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
