"""AI Counterfactual Recommendation Engine (Sentinel AI Recommendation Engine).

Identifies minimal, realistic feature changes to lower predicted risk for events
scored by Sentinel Fusion AI specialist models, probing model decision boundaries
without retraining or modifying existing models.
"""
from __future__ import annotations

import copy
import math
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from ml.config import route
from service.schemas import (
    CounterfactualRecommendation,
    CounterfactualResponse,
    EventIn,
    FeatureChange,
    RiskLevel,
)

RISK_LEVEL_ORDER: dict[RiskLevel, int] = {
    "low": 0,
    "medium": 1,
    "high": 2,
    "critical": 3,
}

# Domain feature mutability classifications and candidate perturbation rules
MUTABLE_FEATURE_SPECS: dict[str, dict[str, Any]] = {
    "amount": {
        "mutable": True,
        "type": "continuous",
        "actionability": 0.85,
        "unit": "currency",
        "generate_candidates": lambda orig, ev: [
            round(orig * f, 2) for f in [0.75, 0.50, 0.25, 0.10] if orig * f > 0
        ] + ([round(float(ev["balance_before"]), 2)] if ev.get("balance_before") and ev["balance_before"] < orig else []),
        "description": lambda orig, rec, ev: f"Reduce transaction amount from {orig} to {rec}",
        "explanation": lambda orig, rec, ev: "Lowering transaction amount brings it within customer's normal baseline spend.",
    },
    "counterparty_is_new": {
        "mutable": True,
        "type": "discrete",
        "actionability": 0.90,
        "generate_candidates": lambda orig, ev: [0] if orig == 1 else [],
        "description": lambda orig, rec, ev: "Use an existing trusted beneficiary instead of a newly added one",
        "explanation": lambda orig, rec, ev: "Transactions to established beneficiaries carry significantly lower fraud probability.",
    },
    "f_counterparty_new": {
        "mutable": True,
        "type": "discrete",
        "actionability": 0.90,
        "generate_candidates": lambda orig, ev: [0] if orig == 1 else [],
        "description": lambda orig, rec, ev: "Transfer to a previously verified counterparty",
        "explanation": lambda orig, rec, ev: "Verified counterparty histories reduce risk score across financial models.",
    },
    "bank_is_new_beneficiary": {
        "mutable": True,
        "type": "discrete",
        "actionability": 0.90,
        "generate_candidates": lambda orig, ev: [0] if orig == 1 else [],
        "description": lambda orig, rec, ev: "Select a beneficiary with prior successful transfers",
        "explanation": lambda orig, rec, ev: "Beneficiary trust history satisfies bank risk policy criteria.",
    },
    "bank_beneficiary_age_s": {
        "mutable": True,
        "type": "continuous",
        "actionability": 0.75,
        "unit": "days",
        "generate_candidates": lambda orig, ev: [7 * 86400.0, 30 * 86400.0],
        "description": lambda orig, rec, ev: f"Wait until beneficiary has at least {int(rec / 86400)} days of history before high-value transfer",
        "explanation": lambda orig, rec, ev: "Allowing beneficiary trust age to mature eliminates new-beneficiary risk spikes.",
    },
    "counterparty_age_s": {
        "mutable": True,
        "type": "continuous",
        "actionability": 0.75,
        "unit": "days",
        "generate_candidates": lambda orig, ev: [7 * 86400.0, 30 * 86400.0],
        "description": lambda orig, rec, ev: f"Initiate payment after beneficiary account age reaches {int(rec / 86400)} days",
        "explanation": lambda orig, rec, ev: "Matured counterparty age lowers synthetic/mule account risk.",
    },
    "device_is_new": {
        "mutable": True,
        "type": "discrete",
        "actionability": 0.80,
        "generate_candidates": lambda orig, ev: [0] if orig == 1 else [],
        "description": lambda orig, rec, ev: "Perform transaction using a previously trusted device",
        "explanation": lambda orig, rec, ev: "Authenticating from a recognized device eliminates new-device risk elevation.",
    },
    "is_foreign_request": {
        "mutable": True,
        "type": "discrete",
        "actionability": 0.85,
        "generate_candidates": lambda orig, ev: [0] if orig == 1 else [],
        "description": lambda orig, rec, ev: "Initiate request from customer home jurisdiction",
        "explanation": lambda orig, rec, ev: "Domestic requests avoid cross-border anomaly flags.",
    },
    "email_is_free": {
        "mutable": True,
        "type": "discrete",
        "actionability": 0.70,
        "generate_candidates": lambda orig, ev: [0] if orig == 1 else [],
        "description": lambda orig, rec, ev: "Provide a corporate or verified ISP email domain instead of webmail",
        "explanation": lambda orig, rec, ev: "Verified domain emails reduce application fraud risk.",
    },
    "bytes_out": {
        "mutable": True,
        "type": "continuous",
        "actionability": 0.80,
        "unit": "bytes",
        "generate_candidates": lambda orig, ev: [round(orig * 0.5), round(orig * 0.25), 1024] if orig > 1024 else [],
        "description": lambda orig, rec, ev: f"Reduce outbound data transfer volume from {int(orig)} bytes to {int(rec)} bytes",
        "explanation": lambda orig, rec, ev: "Lower outbound payload size mitigates data exfiltration risk signals.",
    },
    "bytes_in": {
        "mutable": True,
        "type": "continuous",
        "actionability": 0.80,
        "unit": "bytes",
        "generate_candidates": lambda orig, ev: [round(orig * 0.5), round(orig * 0.25)] if orig > 1024 else [],
        "description": lambda orig, rec, ev: f"Segment incoming data payload to {int(rec)} bytes",
        "explanation": lambda orig, rec, ev: "Controlled inbound payload size stays within expected protocol limits.",
    },
    "session_length_s": {
        "mutable": True,
        "type": "continuous",
        "actionability": 0.70,
        "unit": "seconds",
        "generate_candidates": lambda orig, ev: [300.0, 600.0] if orig > 1800 else [120.0],
        "description": lambda orig, rec, ev: f"Adjust active session duration to normal range ({int(rec)}s)",
        "explanation": lambda orig, rec, ev: "Session length within standard user limits eliminates session anomaly score.",
    },
    "duration_s": {
        "mutable": True,
        "type": "continuous",
        "actionability": 0.75,
        "unit": "seconds",
        "generate_candidates": lambda orig, ev: [round(orig * 0.5, 2), 1.0],
        "description": lambda orig, rec, ev: f"Reduce connection duration to {rec}s",
        "explanation": lambda orig, rec, ev: "Shorter connection duration reduces persistence risk score.",
    },
    "q_key_exchange": {
        "mutable": True,
        "type": "categorical",
        "actionability": 0.95,
        "generate_candidates": lambda orig, ev: [
            "Kyber768", "ML-KEM-768", "Kyber1024"
        ] if orig in ("RSA", "ECDH", "DH", "RSA-2048", "ECDH-P256", None) else [],
        "description": lambda orig, rec, ev: f"Upgrade quantum-vulnerable key exchange ({orig or 'legacy'}) to quantum-safe {rec}",
        "explanation": lambda orig, rec, ev: f"Post-quantum hybrid algorithm {rec} neutralizes quantum decryption threat.",
    },
    "q_cert_key_type": {
        "mutable": True,
        "type": "categorical",
        "actionability": 0.95,
        "generate_candidates": lambda orig, ev: [
            "FALCON512", "ML-DSA-65", "Dilithium3"
        ] if orig in ("RSA-2048", "ECDSA-P256", "RSA-4096", None) else [],
        "description": lambda orig, rec, ev: f"Replace vulnerable certificate key ({orig or 'legacy'}) with post-quantum {rec}",
        "explanation": lambda orig, rec, ev: f"NIST-standardized post-quantum signature algorithm {rec} protects certificate integrity.",
    },
}


def _update_dependent_engineered_features(ev_dict: dict[str, Any]) -> dict[str, Any]:
    """Recompute dependent engineered f_* features when raw features change."""
    d = copy.deepcopy(ev_dict)
    amt = d.get("amount")
    if amt is not None and isinstance(amt, (int, float)) and amt >= 0:
        d["f_log1p_amount"] = float(np.log1p(amt))

        # Update balance drain ratio if balance_before is present
        bal_before = d.get("balance_before")
        if bal_before is not None and isinstance(bal_before, (int, float)) and bal_before > 0:
            d["f_balance_drain_ratio"] = float(amt / bal_before)
            d["f_amount_vs_balance"] = float(amt / (bal_before + 1.0))
            if d.get("balance_after") is not None:
                expected_after = bal_before - amt
                d["f_balance_inconsistent"] = 1.0 if abs(d["balance_after"] - expected_after) > 0.01 else 0.0

    bytes_in = d.get("bytes_in")
    if bytes_in is not None and isinstance(bytes_in, (int, float)) and bytes_in >= 0:
        d["f_log1p_bytes_in"] = float(np.log1p(bytes_in))

    bytes_out = d.get("bytes_out")
    if bytes_out is not None and isinstance(bytes_out, (int, float)) and bytes_out >= 0:
        d["f_log1p_bytes_out"] = float(np.log1p(bytes_out))

    if bytes_in is not None and bytes_out is not None and isinstance(bytes_in, (int, float)) and isinstance(bytes_out, (int, float)):
        d["f_bytes_ratio"] = float((bytes_out + 1.0) / (bytes_in + 1.0))

    cp_new = d.get("counterparty_is_new") or d.get("bank_is_new_beneficiary")
    if cp_new is not None:
        d["f_counterparty_new"] = float(cp_new)

    dev_new = d.get("device_is_new")
    if dev_new is not None:
        d["f_device_new"] = float(dev_new)

    return d


class CounterfactualEngine:
    """Generates counterfactual recommendations derived from model decision boundaries."""

    def __init__(self, app_state: Any) -> None:
        self.app_state = app_state

    async def generate_counterfactuals(
        self,
        event_dict: dict[str, Any],
        target_risk_level: RiskLevel = "low",
        max_recommendations: int = 3,
    ) -> CounterfactualResponse:
        st = self.app_state
        event_id = str(event_dict.get("event_id", "unknown"))

        # 1. Baseline scoring
        feat_results = await st.features.build_many([event_dict])
        merged_orig = [{**event_dict, **feat_results[0][0]}]
        scores_orig = st.scorer.score(merged_orig)[0]

        orig_risk_score = float(scores_orig["risk_score"])
        orig_risk_level: RiskLevel = scores_orig["risk_level"]
        model_key = scores_orig.get("model")

        # If event is already at or below target risk level, return empty counterfactuals
        if RISK_LEVEL_ORDER[orig_risk_level] <= RISK_LEVEL_ORDER[target_risk_level]:
            return CounterfactualResponse(
                event_id=event_id,
                original_risk_score=orig_risk_score,
                original_risk_level=orig_risk_level,
                target_risk_level=target_risk_level,
                model=model_key,
                counterfactuals=[],
            )

        # 2. Extract SHAP attributions
        top_shap_features: list[str] = []
        if hasattr(st, "explainer") and st.explainer and scores_orig["scored"]:
            expl = st.explainer.explain(merged_orig[0])
            if expl and "top_features" in expl:
                # Get features contributing positively to risk
                top_shap_features = [
                    tf["feature"] for tf in expl["top_features"] if tf.get("shap", 0) > 0
                ]

        # 3. Identify candidate mutable features
        # Start with top SHAP features, then add remaining registered mutable features
        candidate_features: list[str] = []
        for feat in top_shap_features:
            # Map engineered feature to raw mutable feature if needed
            raw_feat = feat
            if feat.startswith("f_") and feat in ("f_counterparty_new", "f_log1p_amount", "f_amount_z_user", "f_amount_ratio_mean"):
                if feat == "f_counterparty_new":
                    raw_feat = "counterparty_is_new"
                elif feat in ("f_log1p_amount", "f_amount_z_user", "f_amount_ratio_mean"):
                    raw_feat = "amount"
            if raw_feat in MUTABLE_FEATURE_SPECS and raw_feat not in candidate_features:
                candidate_features.append(raw_feat)

        for feat, spec in MUTABLE_FEATURE_SPECS.items():
            if feat not in candidate_features and feat in event_dict and event_dict[feat] is not None:
                candidate_features.append(feat)

        # 4. Generate candidate scenarios (Single-feature & Multi-feature combinations)
        candidates_to_score: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []

        # Single-feature interventions
        for feat in candidate_features:
            spec = MUTABLE_FEATURE_SPECS[feat]
            orig_val = event_dict.get(feat)
            if orig_val is None:
                continue

            possible_vals = spec["generate_candidates"](orig_val, event_dict)
            for rec_val in possible_vals:
                if rec_val == orig_val:
                    continue
                cand_event = copy.deepcopy(event_dict)
                cand_event[feat] = rec_val
                cand_event = _update_dependent_engineered_features(cand_event)

                change_obj = {
                    "feature": feat,
                    "original_value": orig_val,
                    "recommended_value": rec_val,
                    "delta": round(float(rec_val - orig_val), 4) if isinstance(rec_val, (int, float)) and isinstance(orig_val, (int, float)) else None,
                    "unit": spec.get("unit"),
                    "change_description": spec["description"](orig_val, rec_val, event_dict),
                    "explanation": spec["explanation"](orig_val, rec_val, event_dict),
                    "actionability": spec.get("actionability", 0.8),
                }
                candidates_to_score.append((cand_event, [change_obj]))

        # Multi-feature interventions (pairs) if available
        if len(candidate_features) >= 2:
            feat1, feat2 = candidate_features[0], candidate_features[1]
            spec1, spec2 = MUTABLE_FEATURE_SPECS[feat1], MUTABLE_FEATURE_SPECS[feat2]
            v1_list = spec1["generate_candidates"](event_dict.get(feat1), event_dict) if event_dict.get(feat1) is not None else []
            v2_list = spec2["generate_candidates"](event_dict.get(feat2), event_dict) if event_dict.get(feat2) is not None else []
            if v1_list and v2_list:
                rec1, rec2 = v1_list[0], v2_list[0]
                orig1, orig2 = event_dict.get(feat1), event_dict.get(feat2)
                cand_event = copy.deepcopy(event_dict)
                cand_event[feat1] = rec1
                cand_event[feat2] = rec2
                cand_event = _update_dependent_engineered_features(cand_event)

                change1 = {
                    "feature": feat1,
                    "original_value": orig1,
                    "recommended_value": rec1,
                    "delta": round(float(rec1 - orig1), 4) if isinstance(rec1, (int, float)) and isinstance(orig1, (int, float)) else None,
                    "unit": spec1.get("unit"),
                    "change_description": spec1["description"](orig1, rec1, event_dict),
                    "explanation": spec1["explanation"](orig1, rec1, event_dict),
                    "actionability": spec1.get("actionability", 0.8),
                }
                change2 = {
                    "feature": feat2,
                    "original_value": orig2,
                    "recommended_value": rec2,
                    "delta": round(float(rec2 - orig2), 4) if isinstance(rec2, (int, float)) and isinstance(orig2, (int, float)) else None,
                    "unit": spec2.get("unit"),
                    "change_description": spec2["description"](orig2, rec2, event_dict),
                    "explanation": spec2["explanation"](orig2, rec2, event_dict),
                    "actionability": spec2.get("actionability", 0.8),
                }
                candidates_to_score.append((cand_event, [change1, change2]))

        if not candidates_to_score:
            return CounterfactualResponse(
                event_id=event_id,
                original_risk_score=orig_risk_score,
                original_risk_level=orig_risk_level,
                target_risk_level=target_risk_level,
                model=model_key,
                counterfactuals=[],
            )

        # 5. Re-run inference across all candidate events
        cand_events_only = [c[0] for c in candidates_to_score]
        feat_results_cand = await st.features.build_many(cand_events_only)
        merged_cands = [
            {**cand, **fr[0]} for cand, fr in zip(cand_events_only, feat_results_cand, strict=True)
        ]
        scored_cands = st.scorer.score(merged_cands)

        # 6. Process and rank candidates
        valid_recs: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []

        for i, scored in enumerate(scored_cands):
            pred_score = float(scored["risk_score"])
            pred_level: RiskLevel = scored["risk_level"]
            changes_meta = candidates_to_score[i][1]

            # Only accept if risk is strictly reduced
            if pred_score >= orig_risk_score:
                continue

            target_reached = RISK_LEVEL_ORDER[pred_level] <= RISK_LEVEL_ORDER[target_risk_level]
            risk_reduction_pct = round(max(0.0, (orig_risk_score - pred_score) / max(orig_risk_score, 1e-6) * 100.0), 2)

            avg_actionability = sum(c["actionability"] for c in changes_meta) / len(changes_meta)
            num_changes = len(changes_meta)

            # Combined ranking score (lower is better)
            # Prioritize reaching target level, higher risk reduction, fewer changes, higher actionability
            rank_score = (
                (0 if target_reached else 100)
                - (risk_reduction_pct * 2.0)
                + (num_changes * 10.0)
                - (avg_actionability * 20.0)
            )

            rec_data = {
                "predicted_risk_score": pred_score,
                "predicted_risk_level": pred_level,
                "risk_reduction_pct": risk_reduction_pct,
                "confidence": round(min(0.99, max(0.60, 1.0 - pred_score)), 4),
                "actionability_score": round(avg_actionability, 2),
                "rank_score": rank_score,
                "target_reached": target_reached,
            }
            valid_recs.append((rec_data, changes_meta))

        # Sort recommendations by rank_score ascending
        valid_recs.sort(key=lambda x: x[0]["rank_score"])

        # Construct final output objects
        final_counterfactuals: list[CounterfactualRecommendation] = []
        for rank_idx, (rdata, changes_meta) in enumerate(valid_recs[:max_recommendations], start=1):
            feature_changes: list[FeatureChange] = []
            explanations_list: list[str] = []

            for c in changes_meta:
                feature_changes.append(
                    FeatureChange(
                        feature=c["feature"],
                        original_value=c["original_value"],
                        recommended_value=c["recommended_value"],
                        delta=c["delta"],
                        unit=c["unit"],
                        change_description=c["change_description"],
                    )
                )
                explanations_list.append(c["explanation"])

            combined_explanation = " ".join(explanations_list) + f" This lowers the risk score from {orig_risk_score:.4f} to {rdata['predicted_risk_score']:.4f} ({rdata['predicted_risk_level'].upper()} risk)."

            final_counterfactuals.append(
                CounterfactualRecommendation(
                    rank=rank_idx,
                    predicted_risk_score=rdata["predicted_risk_score"],
                    predicted_risk_level=rdata["predicted_risk_level"],
                    risk_reduction_pct=rdata["risk_reduction_pct"],
                    confidence=rdata["confidence"],
                    actionability_score=rdata["actionability_score"],
                    changes=feature_changes,
                    explanation=combined_explanation,
                )
            )

        return CounterfactualResponse(
            event_id=event_id,
            original_risk_score=orig_risk_score,
            original_risk_level=orig_risk_level,
            target_risk_level=target_risk_level,
            model=model_key,
            counterfactuals=final_counterfactuals,
        )
