"""Prometheus instrumentation. Uses a private registry so it never collides with
other collectors and is trivial to reset in tests."""
from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest

REGISTRY = CollectorRegistry()

SCORE_LATENCY = Histogram(
    "sentinel_score_latency_seconds", "End-to-end scoring latency",
    ["endpoint"], registry=REGISTRY,
    buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0))

SCORED_TOTAL = Counter(
    "sentinel_scored_total", "Events scored", ["model", "risk_level"],
    registry=REGISTRY)

DEGRADED_TOTAL = Counter(
    "sentinel_degraded_total", "Events scored without live feature-store state",
    registry=REGISTRY)

FEEDBACK_TOTAL = Counter(
    "sentinel_feedback_total", "Feedback events applied", ["applied"],
    registry=REGISTRY)

INGESTED_TOTAL = Counter(
    "sentinel_ingested_total", "Context events ingested without scoring",
    registry=REGISTRY)

# §5.4 observability. `degraded_total` alone cannot distinguish "brand-new
# customer" from "Redis is down" — the first is normal, the second is an
# incident. Track them separately, plus the score distribution and feature
# null-rate so silent degradation is visible before the bank reports it.
COLD_ENTITY_TOTAL = Counter(
    "sentinel_cold_entity_total", "Events scored with no prior entity history",
    ["entity"], registry=REGISTRY)

RISK_SCORE = Histogram(
    "sentinel_risk_score", "Fused risk score distribution", ["model"],
    registry=REGISTRY,
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0))

FEATURE_NULL_TOTAL = Counter(
    "sentinel_feature_null_total", "Model features that arrived NaN",
    ["model", "feature"], registry=REGISTRY)

FEATURE_SEEN_TOTAL = Counter(
    "sentinel_feature_seen_total", "Model feature observations",
    ["model"], registry=REGISTRY)


def render() -> bytes:
    return generate_latest(REGISTRY)
