"""Recommendation engine: maps current MITRE stage + risk level to
immediate defensive actions and Sentinel response tracks.

All lookups are deterministic — no ML required.
"""
from __future__ import annotations

from .attack_kb import STAGES

# Extra cross-cutting actions by risk level (appended at critical)
_RISK_LEVEL_ACTIONS: dict[str, list[str]] = {
    "critical": [
        "Escalate to Tier-3 SOC immediately",
        "Open P1 incident ticket",
        "Notify CISO and executive team",
    ],
    "high": [
        "Escalate to Tier-2 SOC",
        "Open P2 incident ticket",
    ],
    "medium": [
        "Log and monitor — escalate if risk increases",
    ],
    "low": [
        "Log event for audit trail",
    ],
}


def get_immediate_actions(stage_id: str, risk_level: str) -> list[str]:
    """Return ordered immediate defensive actions for current stage + risk level."""
    stage = STAGES.get(stage_id)
    base_actions = list(stage.sentinel_response) if stage else []

    extra = _RISK_LEVEL_ACTIONS.get(risk_level, [])
    return base_actions + extra


def get_sentinel_response_track(current_stage_id: str) -> list[dict[str, str]]:
    """Return the ordered 'With Sentinel' response track for current stage.

    Each entry: {step_index, action, outcome, stage_blocked}
    """
    stage = STAGES.get(current_stage_id)
    if stage is None:
        return []

    steps = []
    for i, action in enumerate(stage.sentinel_response, start=1):
        steps.append({
            "step_index": str(i),
            "action": action,
            "outcome": _sentinel_outcome(action),
            "stage_blocked": current_stage_id,
        })

    # Always conclude with containment confirmation
    steps.append({
        "step_index": str(len(steps) + 1),
        "action": "Attack Contained",
        "outcome": f"Attack progression halted at {stage.name} stage",
        "stage_blocked": current_stage_id,
    })
    return steps


def get_without_sentinel_progression(current_stage_id: str) -> list[str]:
    """Return 'Without Sentinel' attacker next-step descriptions."""
    stage = STAGES.get(current_stage_id)
    if stage is None:
        return ["Attack progression continues undetected"]

    next_steps = list(stage.without_sentinel_next)

    # Append predicted downstream impacts from transitions
    for next_stage_id, _ in stage.transitions[:2]:
        next_stage = STAGES.get(next_stage_id)
        if next_stage:
            next_steps.append(next_stage.name)

    return next_steps


def _sentinel_outcome(action: str) -> str:
    """Map action string to expected outcome description."""
    action_lower = action.lower()
    if "block" in action_lower:
        return "Connection terminated — attacker access cut"
    if "isolat" in action_lower:
        return "Host removed from network — lateral movement prevented"
    if "revoke" in action_lower or "reset" in action_lower:
        return "Credentials invalidated — attacker access revoked"
    if "terminat" in action_lower:
        return "Process killed — execution stopped"
    if "alert" in action_lower or "notif" in action_lower:
        return "SOC alerted — human analyst engaged"
    if "restore" in action_lower or "re-enable" in action_lower:
        return "Visibility restored — evasion technique neutralised"
    if "preserv" in action_lower or "captur" in action_lower:
        return "Evidence preserved — forensic investigation enabled"
    if "initiat" in action_lower or "engage" in action_lower:
        return "Incident response activated"
    return "Defensive action applied"
