"""AI Attack Replay Engine — orchestrator.

Consumes Cyber Watcher scoring output and produces a structured
AttackReplayResponse for frontend animated replay.

No generative AI. All outputs are derived deterministically from:
- Cyber Watcher model predictions (risk score, SHAP attributions)
- Raw event fields
- MITRE ATT&CK knowledge base (attack_kb.py)

Usage:
    engine = AttackReplayEngine(app_state)
    response = engine.investigate(
        event_dict=event_dict,
        score_result=score_result,
        explanation=explanation,
        sentinel_mode=True,
    )
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from ..schemas import (
    AttackReplayResponse,
    AttackStageInfo,
    EvidenceSignal,
    PredictedStage,
    ReplayStep,
    ScoreOut,
    SentinelResponseStep,
)
from .attack_kb import STAGES
from .confidence import compute_confidence
from .evidence_mapper import _EvidenceSignalRaw, map_evidence
from .progression_engine import get_completed_stages, get_predicted_transitions
from .recommendation_engine import (
    get_immediate_actions,
    get_sentinel_response_track,
    get_without_sentinel_progression,
)
from .stage_classifier import classify_stage


class AttackReplayEngine:
    """Stateless orchestrator — safe for concurrent requests."""

    def __init__(self, app_state: Any) -> None:
        # Keep a reference to app state so routers can pass it through.
        # The engine itself makes no store or model calls — the router
        # pre-computes score_result and explanation before calling investigate().
        self._app_state = app_state

    def investigate(
        self,
        event_dict: Mapping[str, Any],
        score_result: Mapping[str, Any],
        explanation: Mapping[str, Any] | None,
        score_out: ScoreOut,
        sentinel_mode: bool = True,
    ) -> AttackReplayResponse:
        """Run full investigation pipeline and return replay response."""
        event_id = str(event_dict.get("event_id", f"ev-{uuid.uuid4().hex[:8]}"))
        incident_id = f"inc-{event_id}"
        risk_score = float(score_result.get("risk_score", 0.5))
        risk_level = str(score_result.get("risk_level", "medium"))
        model_version = str(score_result.get("model_version", "dev"))
        investigated_at = datetime.now(timezone.utc)

        event_time_raw = event_dict.get("event_time")
        if isinstance(event_time_raw, datetime):
            event_time = event_time_raw
        elif isinstance(event_time_raw, str):
            try:
                event_time = datetime.fromisoformat(event_time_raw)
            except ValueError:
                event_time = investigated_at
        else:
            event_time = investigated_at

        # 1. Map evidence
        raw_evidence = map_evidence(event_dict, explanation)

        # 2. Classify current stage
        current_stage_id, attack_maturity = classify_stage(raw_evidence, risk_score)
        current_stage_kb = STAGES[current_stage_id]
        current_stage = _stage_info(current_stage_kb)

        # 3. Completed stages (walk-back)
        completed_ids = get_completed_stages(current_stage_id)
        completed_stages = [_stage_info(STAGES[s]) for s in completed_ids if s in STAGES]

        # 4. Build typed evidence signals (schema objects)
        observed_evidence = [_to_schema_signal(s) for s in raw_evidence]

        # 5. Build replay timeline
        replay_timeline = _build_replay_timeline(
            completed_ids, current_stage_id, event_time, raw_evidence
        )

        # 6. Predicted stages
        transitions = get_predicted_transitions(current_stage_id)
        predicted_stages: list[PredictedStage] = []
        for next_stage_id, base_prob in transitions:
            if next_stage_id not in STAGES:
                continue
            confidence, prob_label = compute_confidence(
                next_stage_id, base_prob, risk_score, raw_evidence
            )
            next_kb = STAGES[next_stage_id]
            supporting = _build_supporting_evidence(next_stage_id, raw_evidence)
            actions = get_immediate_actions(next_stage_id, risk_level)
            explanation_str = _explain_prediction(
                current_stage_id, next_stage_id, base_prob, risk_level
            )
            predicted_stages.append(PredictedStage(
                stage_id=next_stage_id,
                stage_name=next_kb.name,
                kill_chain_phase=next_kb.kill_chain_phase,
                confidence=confidence,
                probability_label=prob_label,
                explanation=explanation_str,
                supporting_evidence=supporting,
                recommended_actions=actions,
            ))

        # 7. Sentinel response track
        sentinel_response: list[SentinelResponseStep] = []
        if sentinel_mode:
            for step in get_sentinel_response_track(current_stage_id):
                sentinel_response.append(SentinelResponseStep(
                    step_index=int(step["step_index"]),
                    action=step["action"],
                    outcome=step["outcome"],
                    stage_blocked=step["stage_blocked"],
                ))

        # 8. AI summary
        ai_summary = _build_summary(
            event_dict, current_stage_id, attack_maturity,
            risk_score, risk_level, predicted_stages, raw_evidence
        )

        # 9. Overall investigation confidence
        investigation_confidence = _overall_confidence(risk_score, raw_evidence)

        return AttackReplayResponse(
            incident_id=incident_id,
            event_id=event_id,
            domain=str(event_dict.get("event_domain", "cyber")),
            risk_score=risk_score,
            risk_level=risk_level,  # type: ignore[arg-type]
            model_version=model_version,
            investigated_at=investigated_at,
            score=score_out,
            current_stage=current_stage,
            attack_maturity=attack_maturity,
            completed_stages=completed_stages,
            replay_timeline=replay_timeline,
            observed_evidence=observed_evidence,
            predicted_stages=predicted_stages,
            sentinel_response=sentinel_response,
            ai_summary=ai_summary,
            investigation_confidence=investigation_confidence,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _stage_info(kb_stage: Any) -> AttackStageInfo:
    return AttackStageInfo(
        stage_id=kb_stage.id,
        stage_name=kb_stage.name,
        kill_chain_phase=kb_stage.kill_chain_phase,
        mitre_tactic_id=kb_stage.mitre_tactic_id,
        description=kb_stage.description,
    )


def _to_schema_signal(sig: _EvidenceSignalRaw) -> EvidenceSignal:
    return EvidenceSignal(
        feature=sig.feature,
        value=sig.value,
        shap_attribution=sig.shap_attribution,
        description=sig.description,
        stage_hints=list(sig.stage_hints),
    )


def _build_replay_timeline(
    completed_ids: list[str],
    current_stage_id: str,
    event_time: datetime,
    evidence: list[_EvidenceSignalRaw],
) -> list[ReplayStep]:
    """Build ordered replay steps from initial_access through current stage."""
    stages_to_show = completed_ids + [current_stage_id]
    steps: list[ReplayStep] = []

    # Distribute timestamps backwards so they appear historically plausible
    # Each prior stage is 5 minutes earlier than the next.
    n = len(stages_to_show)
    for i, stage_id in enumerate(stages_to_show):
        if stage_id not in STAGES:
            continue
        kb = STAGES[stage_id]
        offset_minutes = (n - 1 - i) * 5
        ts = event_time - timedelta(minutes=offset_minutes)

        # Collect evidence signals that hint at this stage
        stage_evidence = [
            _to_schema_signal(s)
            for s in evidence
            if stage_id in s.stage_hints
        ]

        is_current = stage_id == current_stage_id
        steps.append(ReplayStep(
            step_index=i + 1,
            stage_id=stage_id,
            stage_name=kb.name,
            timestamp=ts,
            title=f"{'[DETECTED] ' if is_current else ''}{kb.name}",
            description=kb.description,
            evidence=stage_evidence,
            is_sentinel_intervention=False,
        ))

    # Append Sentinel intervention marker
    steps.append(ReplayStep(
        step_index=len(steps) + 1,
        stage_id="sentinel_intervention",
        stage_name="Sentinel Intervention",
        timestamp=event_time,
        title="🚨 Sentinel Intervention",
        description="Sentinel Fusion AI detected the threat and initiated defensive response.",
        evidence=[],
        is_sentinel_intervention=True,
    ))

    return steps


def _build_supporting_evidence(
    target_stage_id: str,
    evidence: list[_EvidenceSignalRaw],
) -> list[str]:
    """Plain-text bullets supporting why a stage is predicted."""
    bullets: list[str] = []
    for sig in evidence:
        if target_stage_id in sig.stage_hints:
            bullets.append(sig.description)
    if not bullets:
        kb = STAGES.get(target_stage_id)
        if kb:
            bullets.append(
                f"{kb.name} is a common follow-on from the current attack stage "
                f"based on MITRE ATT&CK tactic ordering ({kb.mitre_tactic_id})"
            )
    return bullets[:4]


def _explain_prediction(
    current_stage_id: str,
    next_stage_id: str,
    base_prob: float,
    risk_level: str,
) -> str:
    current = STAGES.get(current_stage_id)
    nxt = STAGES.get(next_stage_id)
    if not current or not nxt:
        return f"Predicted based on attack progression probability ({base_prob:.0%})"
    return (
        f"After {current.name}, {base_prob:.0%} of similar attack chains progress to "
        f"{nxt.name} ({nxt.mitre_tactic_id}). "
        f"Current {risk_level.upper()} risk level increases this likelihood."
    )


def _build_summary(
    event: Mapping[str, Any],
    current_stage_id: str,
    maturity: str,
    risk_score: float,
    risk_level: str,
    predicted: list[PredictedStage],
    evidence: list[_EvidenceSignalRaw],
) -> str:
    stage = STAGES.get(current_stage_id)
    stage_name = stage.name if stage else current_stage_id.replace("_", " ").title()
    device = event.get("device_id") or "unknown host"
    user = event.get("user_id") or "unknown actor"
    top_pred = predicted[0].stage_name if predicted else "further escalation"
    top_conf = f"{predicted[0].confidence:.0%}" if predicted else "unknown"
    evidence_count = len(evidence)
    return (
        f"Sentinel Fusion AI detected a {risk_level.upper()} severity cyber threat "
        f"(risk score {risk_score:.2f}) on device '{device}' attributed to actor '{user}'. "
        f"The attack is currently in the {stage_name} stage ({maturity} maturity) "
        f"based on {evidence_count} evidence signal(s). "
        f"Most probable next move: {top_pred} (confidence {top_conf}). "
        f"Immediate containment is {'critical' if risk_level in ('high', 'critical') else 'recommended'}."
    )


def _overall_confidence(
    risk_score: float,
    evidence: list[_EvidenceSignalRaw],
) -> float:
    """Overall investigation confidence: average signal strength weighted by risk."""
    if not evidence:
        return round(max(0.05, min(0.95, risk_score * 0.5)), 3)
    avg_strength = sum(s.signal_strength for s in evidence) / len(evidence)
    raw = avg_strength * 0.6 + risk_score * 0.4
    return round(max(0.05, min(0.95, raw)), 3)
