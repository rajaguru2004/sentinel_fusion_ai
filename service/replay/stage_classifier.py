"""Stage classifier: weighted-vote over evidence signals to determine
the current MITRE ATT&CK stage and attack maturity.

Voting:
    Each evidence item votes for its stage_hint.
    Vote weight = signal_strength * max(|shap|, 0.1)
    The stage with the highest cumulative vote wins.

Fallback: if no evidence fires, defaults to DEFAULT_STAGE_ID ("execution").
"""
from __future__ import annotations

from collections import defaultdict

from .attack_kb import DEFAULT_STAGE_ID, STAGE_ORDER, STAGES
from .evidence_mapper import _EvidenceSignalRaw


def classify_stage(
    evidence: list[_EvidenceSignalRaw],
    risk_score: float,
) -> tuple[str, str]:
    """Return (current_stage_id, attack_maturity).

    attack_maturity: "Early" | "Mid" | "Late" | "Critical"
    """
    if not evidence:
        # No evidence — infer from risk score alone
        if risk_score >= 0.8:
            return "execution", "Early"
        return DEFAULT_STAGE_ID, "Early"

    votes: dict[str, float] = defaultdict(float)
    for sig in evidence:
        for stage_id in sig.stage_hints:
            if stage_id not in STAGES:
                continue
            weight = sig.signal_strength * max(abs(sig.shap_attribution), 0.1)
            votes[stage_id] += weight

    if not votes:
        return DEFAULT_STAGE_ID, "Early"

    current_stage_id = max(votes, key=lambda k: votes[k])

    # Validate the stage exists
    if current_stage_id not in STAGES:
        current_stage_id = DEFAULT_STAGE_ID

    # Maturity from KB
    maturity = STAGES[current_stage_id].attack_maturity

    # Upgrade maturity for very high risk even if stage is early
    if risk_score >= 0.90 and maturity == "Early":
        maturity = "Mid"

    return current_stage_id, maturity
