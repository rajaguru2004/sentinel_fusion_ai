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


def render() -> bytes:
    return generate_latest(REGISTRY)
