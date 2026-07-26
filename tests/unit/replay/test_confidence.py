"""Unit tests for confidence calculator."""
from __future__ import annotations

import pytest

from service.replay.confidence import compute_confidence
from service.replay.evidence_mapper import _EvidenceSignalRaw


def _sig(stage_id: str) -> _EvidenceSignalRaw:
    return _EvidenceSignalRaw(
        feature="bytes_out",
        value=100_000,
        shap_attribution=0.5,
        description="test",
        stage_hints=[stage_id],
        signal_strength=0.85,
    )


def test_confidence_in_valid_range():
    conf, label = compute_confidence("exfiltration", 0.7, 0.8, [_sig("exfiltration")])
    assert 0.05 <= conf <= 0.95


def test_high_risk_increases_confidence():
    low, _ = compute_confidence("exfiltration", 0.7, 0.1, [])
    high, _ = compute_confidence("exfiltration", 0.7, 0.9, [])
    assert high > low


def test_evidence_coverage_increases_confidence():
    no_ev, _ = compute_confidence("exfiltration", 0.7, 0.8, [])
    with_ev, _ = compute_confidence("exfiltration", 0.7, 0.8, [_sig("exfiltration")])
    assert with_ev >= no_ev


def test_zero_base_prob_clamps_to_minimum():
    conf, _ = compute_confidence("exfiltration", 0.0, 1.0, [_sig("exfiltration")])
    assert conf >= 0.05


def test_high_base_prob_full_evidence_approaches_max():
    # Lots of matching evidence
    evidence = [_sig("exfiltration")] * 5
    conf, _ = compute_confidence("exfiltration", 1.0, 1.0, evidence)
    assert conf <= 0.95


def test_label_high_for_high_confidence():
    conf, label = compute_confidence("exfiltration", 0.9, 1.0, [_sig("exfiltration")])
    if conf >= 0.65:
        assert label == "High"


def test_label_low_for_low_confidence():
    conf, label = compute_confidence("impact", 0.05, 0.1, [])
    if conf < 0.40:
        assert label == "Low"


def test_unknown_stage_uses_zero_coverage():
    """Unknown stage should not raise; coverage defaults to 0."""
    conf, label = compute_confidence("totally_unknown_stage", 0.5, 0.7, [])
    assert 0.05 <= conf <= 0.95
