"""FastAPI application factory.

Startup loads the SentinelScorer ONCE (CPU-only, sub-second) and builds the
feature store; workers are otherwise stateless (all mutable state in the store),
so the service scales horizontally with no affinity. Entry point:

    uvicorn service.app:create_app --factory --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from .explain import Explainer
from .feature_service import FeatureService
from .routers import feedback, health, metrics, score
from .scorer_service import ScorerService
from .settings import Settings, get_settings
from .store import FeatureStore, InMemoryStore, RedisFeatureStore


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
    app.state.explainer = Explainer(app.state.scorer.scorer, top_k=settings.explain_top_k)
    app.state.store = build_store(settings)
    app.state.features = FeatureService(app.state.store,
                                        timeout_ms=settings.store_timeout_ms)
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
    app.include_router(feedback.router)
    return app


app = create_app()
