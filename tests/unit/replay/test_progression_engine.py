"""Unit tests for progression_engine."""
from __future__ import annotations

import pytest

from service.replay.attack_kb import STAGE_ORDER, STAGES
from service.replay.progression_engine import get_completed_stages, get_predicted_transitions


def test_execution_has_transitions():
    transitions = get_predicted_transitions("execution")
    assert len(transitions) > 0
    for next_id, prob in transitions:
        assert next_id in STAGES
        assert 0.0 < prob <= 1.0


def test_transitions_ordered_by_probability_desc():
    transitions = get_predicted_transitions("execution")
    probs = [p for _, p in transitions]
    assert probs == sorted(probs, reverse=True)


def test_max_predictions_respected():
    transitions = get_predicted_transitions("execution", max_predictions=2)
    assert len(transitions) <= 2


def test_impact_has_no_transitions():
    """Impact is terminal — no next stages."""
    transitions = get_predicted_transitions("impact")
    assert transitions == []


def test_unknown_stage_returns_empty():
    transitions = get_predicted_transitions("totally_unknown_xyz")
    assert transitions == []


def test_completed_stages_execution_has_initial_access():
    completed = get_completed_stages("execution")
    assert "initial_access" in completed


def test_completed_stages_initial_access_has_no_predecessors():
    completed = get_completed_stages("initial_access")
    assert completed == []


def test_completed_stages_ordered_chronologically():
    """Completed stages should follow STAGE_ORDER chronology."""
    completed = get_completed_stages("lateral_movement")
    if len(completed) >= 2:
        indices = [STAGE_ORDER.index(s) for s in completed if s in STAGE_ORDER]
        assert indices == sorted(indices), "Completed stages must be in chronological order"


def test_completed_stages_does_not_include_current():
    current = "collection"
    completed = get_completed_stages(current)
    assert current not in completed


def test_completed_stages_no_cycles():
    for stage_id in STAGES:
        completed = get_completed_stages(stage_id)
        assert len(set(completed)) == len(completed), f"Cycle detected for stage {stage_id}"


def test_all_stages_produce_valid_transitions():
    """Smoke: every stage with transitions points to known stages."""
    for stage_id, stage in STAGES.items():
        for next_id, prob in stage.transitions:
            assert next_id in STAGES, f"{stage_id} -> {next_id} not in STAGES"
            assert 0 < prob <= 1.0
