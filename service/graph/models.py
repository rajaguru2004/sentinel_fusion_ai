"""Pydantic schemas for Dynamic Threat Graph (AI Attack Relationship Visualization)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

NodeType = Literal[
    "customer",
    "device",
    "session",
    "ip_address",
    "location",
    "beneficiary",
    "transaction",
    "bank_account",
    "server",
    "key_pair",
    "service",
    "threat_actor",
    "generic",
]

NodeGroup = Literal["actor", "endpoint", "network", "counterparty", "event", "asset", "crypto"]

EdgeSeverity = Literal["low", "medium", "high", "critical"]

AnimationAction = Literal[
    "REVEAL_NODE",
    "REVEAL_NODE_AND_EDGE",
    "HIGHLIGHT_SUSPICIOUS_PATH",
    "PULSE_CRITICAL_NODE",
    "HIGHLIGHT_ATTACK_CHAIN",
]


class GraphNode(BaseModel):
    """Graph entity node."""
    id: str
    type: NodeType
    label: str
    node_group: NodeGroup = "generic"
    risk_score: float = Field(default=0.0, ge=0.0, le=1.0)
    is_critical: bool = False
    is_highlighted: bool = False
    attributes: dict[str, Any] = Field(default_factory=dict)


class GraphEdge(BaseModel):
    """Directed edge representing relationship between entity nodes."""
    id: str
    source_id: str
    target_id: str
    relation_type: str
    label: str
    reason: str
    severity: EdgeSeverity = "low"
    weight: float = Field(default=0.5, ge=0.0, le=1.0)
    is_suspicious: bool = False
    is_highlighted: bool = False
    timestamp: datetime | None = None


class EvidenceItem(BaseModel):
    """AI decision attribution or anomaly signal tied to node/edge."""
    target_type: Literal["node", "edge", "incident"]
    target_id: str
    feature: str
    feature_value: Any = None
    shap_attribution: float = 0.0
    description: str


class TimelineStep(BaseModel):
    """Chronological event in attack progression."""
    step_index: int
    timestamp: datetime
    title: str
    description: str
    related_nodes: list[str] = Field(default_factory=list)
    related_edges: list[str] = Field(default_factory=list)


class AnimationStep(BaseModel):
    """Visual sequencing instruction for frontend animation playback."""
    step: int
    action: AnimationAction
    node_ids: list[str] = Field(default_factory=list)
    edge_ids: list[str] = Field(default_factory=list)
    message: str


class AIVerdict(BaseModel):
    """Final AI classification and verdict for incident graph."""
    summary: str
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    primary_model: str | None = None
    recommended_actions: list[str] = Field(default_factory=list)


class ThreatGraphResponse(BaseModel):
    """Complete Dynamic Threat Graph response payload."""
    model_config = ConfigDict(extra="ignore")

    incident_id: str
    domain: str
    title: str
    created_at: datetime
    risk_score: float = Field(default=0.0, ge=0.0, le=1.0)
    risk_level: Literal["low", "medium", "high", "critical"] = "low"
    verdict: AIVerdict
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    timeline: list[TimelineStep] = Field(default_factory=list)
    animation_steps: list[AnimationStep] = Field(default_factory=list)
