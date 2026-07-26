"""Unit tests for evidence_mapper."""
from __future__ import annotations

import pytest

from service.replay.evidence_mapper import map_evidence


# ---------------------------------------------------------------------------
# SHAP-based mapping
# ---------------------------------------------------------------------------

def _make_explanation(features: list[dict]) -> dict:
    return {"top_features": features, "reasons": []}


def test_shap_bytes_out_maps_to_exfiltration():
    expl = _make_explanation([
        {"feature": "bytes_out", "value": 200_000, "shap": 0.45},
    ])
    signals = map_evidence({}, expl)
    stage_ids = [s.stage_hints[0] for s in signals]
    assert "exfiltration" in stage_ids


def test_shap_device_history_maps_to_execution():
    expl = _make_explanation([
        {"feature": "f_device_past_hisev_count", "value": 3, "shap": 0.60},
    ])
    signals = map_evidence({}, expl)
    assert any("execution" in s.stage_hints for s in signals)


def test_negative_shap_excluded():
    """Negative SHAP = 'looked normal'; should not appear in evidence."""
    expl = _make_explanation([
        {"feature": "bytes_out", "value": 100, "shap": -0.30},
    ])
    signals = map_evidence({}, expl)
    assert not any(s.feature == "bytes_out" and s.shap_attribution < 0 for s in signals)


def test_unknown_shap_feature_ignored():
    expl = _make_explanation([
        {"feature": "f_totally_unknown_xyz", "value": 1, "shap": 0.99},
    ])
    signals = map_evidence({}, expl)
    # Unknown feature should not generate a signal
    assert not any(s.feature == "f_totally_unknown_xyz" for s in signals)


# ---------------------------------------------------------------------------
# Raw field mapping
# ---------------------------------------------------------------------------

def test_raw_bytes_out_high_maps_to_exfiltration():
    signals = map_evidence({"bytes_out": 80_000}, None)
    assert any("exfiltration" in s.stage_hints for s in signals)


def test_raw_bytes_out_medium_maps_to_collection():
    signals = map_evidence({"bytes_out": 20_000}, None)
    assert any("collection" in s.stage_hints for s in signals)


def test_raw_dst_port_smb_maps_to_lateral_movement():
    signals = map_evidence({"dst_port": 445}, None)
    assert any("lateral_movement" in s.stage_hints for s in signals)


def test_raw_dst_port_rdp_maps_to_lateral_movement():
    signals = map_evidence({"dst_port": 3389}, None)
    assert any("lateral_movement" in s.stage_hints for s in signals)


def test_raw_icmp_maps_to_c2():
    signals = map_evidence({"protocol": "ICMP"}, None)
    assert any("command_and_control" in s.stage_hints for s in signals)


def test_raw_severity_4_maps_to_impact():
    signals = map_evidence({"severity": 4}, None)
    assert any("impact" in s.stage_hints for s in signals)


def test_raw_severity_3_maps_to_execution():
    signals = map_evidence({"severity": 3}, None)
    assert any("execution" in s.stage_hints for s in signals)


def test_raw_foreign_request_maps_to_initial_access():
    signals = map_evidence({"is_foreign_request": 1}, None)
    assert any("initial_access" in s.stage_hints for s in signals)


def test_empty_event_no_signals():
    signals = map_evidence({}, None)
    assert signals == []


def test_sorted_strongest_first():
    """Strongest signal should appear first."""
    expl = _make_explanation([
        {"feature": "f_device_past_hisev_count", "value": 5, "shap": 0.80},  # strength 0.9
        {"feature": "f_user_seq_no", "value": 1, "shap": 0.20},              # strength 0.7
    ])
    signals = map_evidence({}, expl)
    if len(signals) >= 2:
        assert signals[0].signal_strength >= signals[1].signal_strength


def test_no_duplicate_shap_and_raw_for_same_stage():
    """If SHAP and raw rule both hit the same feature+stage, raw is deduplicated."""
    # bytes_out appears in both SHAP signals and RAW_FIELD_SIGNALS for exfiltration
    expl = _make_explanation([
        {"feature": "bytes_out", "value": 80_000, "shap": 0.50},
    ])
    signals = map_evidence({"bytes_out": 80_000}, expl)
    exfil_signals = [s for s in signals if "exfiltration" in s.stage_hints]
    # Only one exfiltration signal from bytes_out (SHAP wins, raw is deduped)
    assert len(exfil_signals) == 1
