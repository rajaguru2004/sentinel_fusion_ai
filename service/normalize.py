"""EventIn -> the plain dict the scorer and feature_core consume.

Keeps the raw unified-schema columns the models read directly (amount,
event_type, ports, protocol, country, bytes, duration, q_* attrs) plus
event_domain/event_time. Engineered f_* features are added later by the feature
service. Missing values stay absent so the model matrix fills them with NaN.
"""
from __future__ import annotations

from typing import Any

from .schemas import EventIn

# Raw columns the models / feature pipeline reference by name.
_PASSTHROUGH = [
    "event_id", "event_domain", "event_time", "user_id", "device_id",
    "event_type", "event_subtype", "country", "amount", "bytes_in", "bytes_out",
    "src_port", "dst_port", "protocol", "duration_s", "severity",
    "q_key_exchange", "q_cert_key_type", "q_data_class",
    "q_cert_age_days", "q_cert_validity_days",
]


def to_event_dict(ev: EventIn) -> dict[str, Any]:
    d = ev.model_dump()
    return {k: d.get(k) for k in _PASSTHROUGH}
