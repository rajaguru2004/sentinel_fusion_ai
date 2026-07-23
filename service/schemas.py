"""Pydantic request/response contract for the banking integration.

Input mirrors the unified event schema (docs/unified_schema.md). Only the three
fields the scorer/feature pipeline strictly need are required; everything else is
optional and, when omitted, becomes NaN downstream (GBM-safe). Output preserves
the columns asserted by tests/integration/test_scorer_contract.py.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Domain = Literal["financial", "cyber", "behaviour", "quantum", "threat_intel"]
RiskLevel = Literal["low", "medium", "high", "critical"]


class EventIn(BaseModel):
    """One security event. Extra fields are rejected to protect the contract."""
    model_config = ConfigDict(extra="forbid")

    event_id: str
    event_domain: Domain
    event_time: datetime  # tz-aware UTC; drives all temporal features + ordering

    # entity keys (optional — some sources are anonymised)
    user_id: str | None = None
    device_id: str | None = None

    # generic event attributes (all optional; missing -> NaN)
    event_type: str | None = None
    event_subtype: str | None = None
    country: str | None = None
    amount: float | None = None
    bytes_in: float | None = None
    bytes_out: float | None = None
    src_port: int | None = None
    dst_port: int | None = None
    protocol: str | None = None
    duration_s: float | None = None
    # severity is NOT a model feature (label-leak exclusion in ml.config); it only
    # folds into device high-severity history for FUTURE events.
    severity: int | None = None

    # quantum native attributes (supply when event_domain == "quantum")
    q_key_exchange: str | None = None
    q_cert_key_type: str | None = None
    q_data_class: str | None = None
    q_cert_age_days: float | None = None
    q_cert_validity_days: float | None = None

    @field_validator("event_time")
    @classmethod
    def _require_tz(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("event_time must be timezone-aware (UTC)")
        return v


class Contributions(BaseModel):
    """Per-domain calibrated risk contributions (None if that domain didn't fire)."""
    p_fraud: float | None = None
    p_cyber: float | None = None
    p_behaviour: float | None = None
    p_quantum: float | None = None


class Explanation(BaseModel):
    model: str
    top_features: list["FeatureAttribution"]


class FeatureAttribution(BaseModel):
    feature: str
    value: float | None
    shap: float


class ScoreOut(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    event_id: str
    model: str | None            # routed model key; None when unscored (e.g. threat_intel)
    raw_score: float | None
    risk_score: float            # 0..1
    risk_level: RiskLevel
    scored: bool
    contributions: Contributions
    model_version: str
    degraded: bool = False       # True when scored without live feature-store state
    explanation: Explanation | None = None


class BatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    events: list[EventIn] = Field(min_length=1)


class BatchOut(BaseModel):
    results: list[ScoreOut]


class FeedbackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str
    user_id: str
    label: Literal[0, 1]


class FeedbackOut(BaseModel):
    event_id: str
    applied: bool                # False when this event_id was already recorded


class HealthOut(BaseModel):
    status: str = "ok"


class ReadyOut(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    ready: bool
    scorer_loaded: bool
    store_ok: bool
    model_version: str


Explanation.model_rebuild()
