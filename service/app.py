"""FastAPI application factory.

Startup loads the SentinelScorer ONCE (CPU-only, sub-second) and builds the
feature store; workers are otherwise stateless (all mutable state in the store),
so the service scales horizontally with no affinity. Entry point:

    uvicorn service.app:create_app --factory --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from ml.feature_spec import CONTRACT_HASH

from .explain import Explainer
from .feature_service import FeatureService
from .routers import feedback, health, ingest, metrics, score
from .scorer_service import ScorerService
from .settings import Settings, get_settings
from .store import FeatureStore, InMemoryStore, RedisFeatureStore


def check_contract(scorer: ScorerService) -> None:
    """Refuse to serve a model trained against a different feature contract.

    This is what makes "training and serving share one contract" enforceable
    rather than aspirational: `ml/feature_spec.py` fingerprints the canonical
    columns, engineered features, per-model inputs and routing, and every bundle
    records the hash it was trained under. Editing a feature list without
    retraining now fails loudly at startup instead of silently mis-scoring every
    request.

    Bundles predating the hash are allowed through with a warning so an older
    artifact directory can still be rolled back to.
    """
    stale = {k: b.get("contract_hash") for k, b in scorer.scorer.bundles.items()
             if b.get("contract_hash") not in (None, CONTRACT_HASH)}
    if stale:
        raise RuntimeError(
            f"feature-contract mismatch: code is {CONTRACT_HASH!r} but bundles "
            f"were trained under {stale}. Retrain (`python -m ml.run_pipeline`) "
            f"or point SENTINEL_MODELS_DIR at matching artifacts.")
    missing = [k for k, b in scorer.scorer.bundles.items()
               if b.get("contract_hash") is None]
    if missing:
        logging.getLogger(__name__).warning(
            "bundles %s predate CONTRACT_HASH — cannot verify train/serve "
            "feature parity", sorted(missing))


def build_store(settings: Settings) -> FeatureStore:
    if not settings.redis_url:
        return InMemoryStore()
    import redis.asyncio as aioredis
    client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return RedisFeatureStore(client, ttl=settings.state_ttl_seconds)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.model_version = settings.model_version
    app.state.scorer = ScorerService(settings.models_dir, version=settings.model_version)
    check_contract(app.state.scorer)
    app.state.contract_hash = CONTRACT_HASH
    app.state.explainer = Explainer(app.state.scorer.scorer, top_k=settings.explain_top_k)
    app.state.store = build_store(settings)
    app.state.features = FeatureService(
        app.state.store, timeout_ms=settings.store_timeout_ms,
        breaker_fail_threshold=settings.breaker_fail_threshold,
        breaker_reset_s=settings.breaker_reset_s)
    try:
        yield
    finally:
        await app.state.store.close()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Sentinel Fusion AI — Risk Scoring API",
        version="1.0.0",
        description="Multi-domain fraud/cyber/behaviour/quantum risk scoring "
                    "with an online feature store, for banking integration.",
        lifespan=lifespan)
    app.include_router(health.router)
    app.include_router(metrics.router)
    app.include_router(score.router)
    app.include_router(ingest.router)
    app.include_router(feedback.router)
    return app


app = create_app()
