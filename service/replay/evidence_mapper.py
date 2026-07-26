"""Evidence mapper: translates Cyber Watcher SHAP features and raw event
fields into typed EvidenceSignal objects with stage hints.

Two passes:
1. SHAP top_features — model-weighted signals (only positive SHAP)
2. Raw event fields — deterministic rule signals (independent of model scoring)

Results are sorted by (signal_strength * |shap|) descending so the
StageClassifier naturally encounters the strongest signals first.
"""
from __future__ import annotations

import math
from typing import Any, Mapping

from .attack_kb import DEFAULT_STAGE_ID, RAW_FIELD_SIGNALS, SHAP_FEATURE_SIGNALS


class _EvidenceSignalRaw:
    """Internal intermediate before schema conversion."""

    __slots__ = (
        "feature", "value", "shap_attribution",
        "description", "stage_hints", "signal_strength",
    )

    def __init__(
        self,
        feature: str,
        value: Any,
        shap_attribution: float,
        description: str,
        stage_hints: list[str],
        signal_strength: float,
    ) -> None:
        self.feature = feature
        self.value = value
        self.shap_attribution = shap_attribution
        self.description = description
        self.stage_hints = stage_hints
        self.signal_strength = signal_strength

    @property
    def sort_key(self) -> float:
        return self.signal_strength * abs(self.shap_attribution) if self.shap_attribution else self.signal_strength


def map_evidence(
    event: Mapping[str, Any],
    explanation: Mapping[str, Any] | None,
) -> list[_EvidenceSignalRaw]:
    """Return sorted evidence signals from SHAP features + raw event fields."""
    signals: list[_EvidenceSignalRaw] = []
    seen_features: set[str] = set()

    # --- Pass 1: SHAP top_features (positive attribution only) ---
    if explanation:
        for feat in explanation.get("top_features", []):
            fname = feat.get("feature", "")
            shap_val = float(feat.get("shap") or 0.0)
            fval = feat.get("value")

            # Skip negative SHAP — "this looked normal" is not a threat signal
            if shap_val <= 0:
                continue

            spec = SHAP_FEATURE_SIGNALS.get(fname)
            if spec is None:
                continue

            # Skip NaN values
            if fval is not None:
                try:
                    if math.isnan(float(fval)):
                        fval = None
                except (TypeError, ValueError):
                    pass

            try:
                desc = spec["description"](fval, shap_val)
            except Exception:
                desc = f"Feature '{fname}' contributed to risk (SHAP={shap_val:+.3f})"

            signals.append(_EvidenceSignalRaw(
                feature=fname,
                value=fval,
                shap_attribution=shap_val,
                description=desc,
                stage_hints=[spec["stage_id"]],
                signal_strength=spec["signal_strength"],
            ))
            seen_features.add(fname)
            # Also register the feature:stage_id key so raw rules don't duplicate
            seen_features.add(f"{fname}:{spec['stage_id']}")

    # --- Pass 2: Raw event-field rules ---
    for sig in RAW_FIELD_SIGNALS:
        field_name = sig["field"]
        raw_val = event.get(field_name)

        try:
            triggered = sig["condition"](raw_val)
        except Exception:
            triggered = False

        if not triggered:
            continue

        # Avoid double-counting if SHAP already covered the same field + stage
        dedup_key = f"{field_name}:{sig['stage_id']}"
        if dedup_key in seen_features:
            continue
        seen_features.add(dedup_key)

        try:
            desc = sig["description"](raw_val)
        except Exception:
            desc = f"Field '{field_name}' triggered {sig['stage_id']} signal"

        signals.append(_EvidenceSignalRaw(
            feature=field_name,
            value=raw_val,
            shap_attribution=0.0,   # raw rule has no SHAP
            description=desc,
            stage_hints=[sig["stage_id"]],
            signal_strength=sig["signal_strength"],
        ))

    # Sort strongest signals first
    signals.sort(key=lambda s: s.sort_key, reverse=True)
    return signals
