"""Unit tests for stage_classifier."""
from __future__ import annotations

from service.replay.attack_kb import DEFAULT_STAGE_ID
from service.replay.evidence_mapper import _EvidenceSignalRaw
from service.replay.stage_classifier import classify_stage


def _sig(stage_id: str, strength: float = 0.8, shap: float = 0.5) -> _EvidenceSignalRaw:
    return _EvidenceSignalRaw(
        feature="test_feature",
        value=1,
        shap_attribution=shap,
        description="test",
        stage_hints=[stage_id],
        signal_strength=strength,
    )


def test_empty_evidence_high_risk_returns_execution():
    stage, maturity = classify_stage([], risk_score=0.85)
    assert stage == "execution"
    assert maturity == "Early"


def test_empty_evidence_low_risk_returns_default():
    stage, maturity = classify_stage([], risk_score=0.3)
    assert stage == DEFAULT_STAGE_ID


def test_single_signal_wins():
    evidence = [_sig("exfiltration")]
    stage, _ = classify_stage(evidence, risk_score=0.9)
    assert stage == "exfiltration"


def test_strongest_signal_wins():
    evidence = [
        _sig("exfiltration", strength=0.9, shap=0.8),
        _sig("initial_access", strength=0.5, shap=0.3),
    ]
    stage, _ = classify_stage(evidence, risk_score=0.75)
    assert stage == "exfiltration"


def test_cumulative_voting():
    """Multiple signals for one stage should beat one strong signal."""
    evidence = [
        _sig("lateral_movement", strength=0.7, shap=0.5),
        _sig("lateral_movement", strength=0.7, shap=0.5),
        _sig("exfiltration", strength=0.9, shap=0.6),  # single high signal
    ]
    stage, _ = classify_stage(evidence, risk_score=0.75)
    # lateral_movement has cumulative vote ~0.49 * 2 = 0.98
    # exfiltration has ~0.54 — lateral_movement should win
    assert stage == "lateral_movement"


def test_maturity_from_kb():
    evidence = [_sig("impact")]
    _, maturity = classify_stage(evidence, risk_score=0.9)
    assert maturity == "Critical"


def test_maturity_upgrade_high_risk_early_stage():
    """Early stage + very high risk should upgrade to Mid."""
    evidence = [_sig("initial_access")]
    _, maturity = classify_stage(evidence, risk_score=0.95)
    assert maturity == "Mid"


def test_maturity_no_upgrade_if_already_late():
    evidence = [_sig("exfiltration")]
    _, maturity = classify_stage(evidence, risk_score=0.95)
    assert maturity == "Critical"


def test_unknown_stage_hint_ignored():
    """Unknown stage ID in hint should not crash; fallback to default."""
    evidence = [_EvidenceSignalRaw(
        feature="x", value=1, shap_attribution=0.5,
        description="d", stage_hints=["totally_unknown_stage"], signal_strength=0.9,
    )]
    stage, _ = classify_stage(evidence, risk_score=0.5)
    assert stage == DEFAULT_STAGE_ID
