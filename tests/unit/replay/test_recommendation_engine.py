"""Unit tests for recommendation_engine."""
from __future__ import annotations

from service.replay.attack_kb import STAGES
from service.replay.recommendation_engine import (
    get_immediate_actions,
    get_sentinel_response_track,
    get_without_sentinel_progression,
)


def test_immediate_actions_critical_includes_escalation():
    actions = get_immediate_actions("exfiltration", "critical")
    joined = " ".join(actions).lower()
    assert any(kw in joined for kw in ["soc", "escalat", "incident", "p1"])


def test_immediate_actions_low_risk_minimal():
    actions = get_immediate_actions("initial_access", "low")
    assert len(actions) >= 1


def test_sentinel_response_track_non_empty():
    track = get_sentinel_response_track("execution")
    assert len(track) >= 1


def test_sentinel_response_track_ends_with_contained():
    track = get_sentinel_response_track("exfiltration")
    last = track[-1]["action"].lower()
    assert "contained" in last or "contain" in last


def test_sentinel_response_track_step_indices_sequential():
    track = get_sentinel_response_track("lateral_movement")
    indices = [int(t["step_index"]) for t in track]
    assert indices == list(range(1, len(indices) + 1))


def test_without_sentinel_includes_next_stages():
    progression = get_without_sentinel_progression("collection")
    assert len(progression) >= 1


def test_without_sentinel_unknown_stage_graceful():
    progression = get_without_sentinel_progression("totally_unknown_xyz")
    assert len(progression) >= 1  # default message


def test_all_stages_have_sentinel_response():
    for stage_id in STAGES:
        track = get_sentinel_response_track(stage_id)
        assert len(track) >= 1, f"No sentinel response for {stage_id}"


def test_all_stages_immediate_actions_high_risk():
    for stage_id in STAGES:
        actions = get_immediate_actions(stage_id, "high")
        assert len(actions) >= 1, f"No actions for {stage_id} at high risk"
