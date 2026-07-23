"""EventIn -> the plain dict the scorer and feature_core consume.

Keeps the raw unified-schema columns the models read directly (amount,
event_type, ports, protocol, country, bytes, duration, q_* attrs) plus
event_domain/event_time. Engineered f_* features are added later by the feature
service. Missing values stay absent so the model matrix fills them with NaN.
"""
from __future__ import annotations

from typing import Any

from ml.feature_spec import CANONICAL_CATEGORICAL, CANONICAL_NUMERIC

from .schemas import EventIn

# Identity/meta columns that are not features but the pipeline needs by name.
_META = ["event_id", "event_domain", "event_time", "user_id", "device_id",
         # severity is NOT a feature (label-derived in v1); it only folds into
         # device high-severity history for FUTURE events.
         "severity",
         # entity keys for the store's set-membership features
         "counterparty_id", "merchant_id",
         # geo inputs to f_geo_distance_km
         "geo_lat", "geo_lon", "counterparty_lat", "counterparty_lon",
         # quantum native attributes
         "q_key_exchange", "q_cert_key_type", "q_data_class",
         "q_cert_age_days", "q_cert_validity_days"]

# Derived from THE contract rather than hand-listed: a canonical column added to
# ml/feature_spec.py is automatically accepted here, so the serving passthrough
# cannot silently fall behind the trained feature set (which is exactly how the
# bank's §3.3 context signals came to be dropped in v1).
_PASSTHROUGH = list(dict.fromkeys(
    [*_META, *CANONICAL_NUMERIC, *CANONICAL_CATEGORICAL]))


def to_event_dict(ev: EventIn) -> dict[str, Any]:
    d = ev.model_dump()
    return {k: d.get(k) for k in _PASSTHROUGH}
