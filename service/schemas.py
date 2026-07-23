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

    # ------------------------------------------------------ banking block ----
    # Canonical banking fields (docs/canonical_schema.md). Requirements doc §3.3:
    # the bank already computes high-signal context that v1 discarded, because
    # `extra="forbid"` rejected anything not listed here. These are now trained
    # features of `fraud_payment`, so sending them materially changes the score.
    counterparty_id: str | None = None
    counterparty_country: str | None = None
    counterparty_is_new: int | None = None
    counterparty_age_s: float | None = None      # bank: beneficiaryAgeMinutes * 60
    name_mismatch: int | None = None             # bank: nameMismatch
    balance_before: float | None = None
    balance_after: float | None = None
    counterparty_balance_before: float | None = None
    counterparty_balance_after: float | None = None
    customer_age: float | None = None
    account_age_s: float | None = None
    income: float | None = None
    channel: str | None = None
    device_os: str | None = None
    device_is_new: int | None = None
    session_length_s: float | None = None
    is_foreign_request: int | None = None
    email_is_free: int | None = None
    merchant_id: str | None = None
    merchant_category: str | None = None
    geo_lat: float | None = None
    geo_lon: float | None = None
    counterparty_lat: float | None = None
    counterparty_lon: float | None = None
    currency: str | None = None
    payment_type: str | None = None
    is_credit: int | None = None

    # Bank-computed signals. Precedence (docs/canonical_schema.md): a
    # store-computed f_* wins when non-NaN; these are trained features in their
    # own right AND the fallback seed when the feature store is cold.
    bank_txn_count_1h: float | None = None        # bank: txnCountLastHour
    bank_amount_vs_user_mean: float | None = None # bank: amountVsUserMean
    bank_beneficiary_age_s: float | None = None   # bank: beneficiaryAgeMinutes * 60
    bank_is_new_beneficiary: int | None = None    # bank: isNewBeneficiary

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
    """Per-model calibrated risk contributions (None if that model didn't fire).

    Schema v2 split the single fraud model into two heads, so the financial
    domain now reports through `p_fraud_payment` or `p_fraud_application`.
    `p_fraud` is kept as a deprecated mirror of whichever fraud head scored the
    event, so an existing bank client keeps working without a coordinated
    release. It will be removed once FinSpark reads the explicit fields.
    """
    p_fraud: float | None = None            # DEPRECATED -> p_fraud_payment
    p_fraud_payment: float | None = None
    p_fraud_application: float | None = None
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
