"""Confidence calculation for predicted attack stages.

Formula:
    confidence = base_prob * (0.5 + 0.3 * risk_factor + 0.2 * coverage)

    base_prob:   KB-defined prior probability for this transition arc
    risk_factor: min(1.0, risk_score / 0.5) — high-risk events amplify confidence
    coverage:    fraction of the stage's expected evidence signals observed

Clamped to [0.05, 0.95] — never claims certainty or impossibility.
"""
from __future__ import annotations

from .attack_kb import STAGES
from .evidence_mapper import _EvidenceSignalRaw


def _label(confidence: float) -> str:
    if confidence >= 0.65:
        return "High"
    if confidence >= 0.40:
        return "Medium"
    return "Low"


def compute_confidence(
    stage_id: str,
    base_probability: float,
    risk_score: float,
    evidence: list[_EvidenceSignalRaw],
) -> tuple[float, str]:
    """Return (confidence_float, label_str)."""
    stage = STAGES.get(stage_id)

    # Coverage: fraction of expected signals observed
    if stage and stage.evidence_signals:
        observed_features = {sig.feature for sig in evidence}
        observed_count = sum(
            1 for s in stage.evidence_signals if s in observed_features
        )
        coverage = observed_count / len(stage.evidence_signals)
    else:
        coverage = 0.0

    # Risk scaling
    risk_factor = min(1.0, risk_score / 0.5)

    raw = base_probability * (0.5 + 0.3 * risk_factor + 0.2 * coverage)
    clamped = round(max(0.05, min(0.95, raw)), 3)
    return clamped, _label(clamped)
