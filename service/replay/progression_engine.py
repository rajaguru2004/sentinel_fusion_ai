"""Progression engine: deterministic KB lookup for attack stage prediction.

Given the current stage, returns:
- predicted_transitions: ordered list of (next_stage_id, base_prob)
- completed_stages: walk backward from current_stage to initial_access
  following the highest-probability predecessor arc
"""
from __future__ import annotations

from .attack_kb import STAGE_ORDER, STAGES


def get_predicted_transitions(
    current_stage_id: str,
    max_predictions: int = 4,
) -> list[tuple[str, float]]:
    """Return top N (next_stage_id, base_probability) arcs from current stage."""
    stage = STAGES.get(current_stage_id)
    if stage is None:
        return []
    # Transitions already ordered by base_prob desc in KB
    return list(stage.transitions[:max_predictions])


def get_completed_stages(current_stage_id: str) -> list[str]:
    """Walk backward from current stage to initial_access using KB predecessors.

    Returns an ordered list of stage IDs from initial_access up to (but not
    including) current_stage — these are the stages already completed.
    """
    if current_stage_id not in STAGES:
        return []

    completed: list[str] = []
    visited: set[str] = {current_stage_id}
    cursor = current_stage_id

    # Limit walk length to prevent cycles
    for _ in range(len(STAGE_ORDER)):
        stage = STAGES[cursor]
        if not stage.predecessor_stages:
            break
        # Pick first predecessor (highest probability predecessor by KB ordering)
        predecessor = stage.predecessor_stages[0]
        if predecessor in visited or predecessor not in STAGES:
            break
        completed.append(predecessor)
        visited.add(predecessor)
        cursor = predecessor

    # Reverse so returned list goes from initial_access -> ... -> immediate predecessor
    completed.reverse()
    return completed
