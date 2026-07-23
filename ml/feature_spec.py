"""THE feature contract — one declaration, shared by training and serving.

Everything downstream reads this module: the offline engineering pass
(:func:`ml.feature_core.engineer_batch`), the online incremental path
(:mod:`service.feature_service` via :mod:`ml.feature_core`), the per-model
matrices (:mod:`ml.features`), and the router in :mod:`ml.predict`.

Why this module exists
----------------------
In v1 the feature definitions lived in three places that had to be kept in sync
by hand: ``ml/config.py::FEATURES`` (model inputs),
``notebooks/src/12_feature_engineering.py`` (offline math) and
``ml/feature_core.py`` (online math). Nothing enforced agreement between them,
so "training and serving share a feature contract" was a convention rather than
a guarantee.

Now there is one declaration and a :data:`CONTRACT_HASH` derived from it. Each
trained bundle records the hash; :func:`service.app.lifespan` refuses to start
when the running code's hash differs from the artifact's. A feature-list change
that is not accompanied by a retrain becomes a loud startup failure instead of a
silent scoring skew.

Leakage rules encoded here
--------------------------
* ``severity`` is never a feature, and (schema v2) is no longer label-derived at
  source. ``f_device_past_hisev_count`` is built FROM severity, so it is dropped
  from the fraud and behaviour contracts; the frozen cyber/quantum models keep it
  with the caveat documented in ``reports/ml/MODELS.md``.
* ``f_user_past_malicious_rate`` is fed by lagged ``/feedback`` online but by
  instant ground truth offline. It stays in the contract only where the offline
  builder applies a matching confirmation lag (see ``LABEL_LAG_*``).
* ``sampling_weight``/``source_dataset``/``label_type``/``event_id`` are never
  features.
"""
from __future__ import annotations

import hashlib
import json

# --------------------------------------------------------------- canonical ---
# Raw columns a model may read directly. Must be a subset of the unified schema
# (notebooks/prep_utils.py::UNIFIED_COLUMNS) and, per docs/canonical_schema.md,
# supplyable by the bank at scoring time.
CANONICAL_NUMERIC = [
    "amount", "duration_s", "bytes_in", "bytes_out", "src_port", "dst_port",
    "balance_before", "balance_after",
    "counterparty_balance_before", "counterparty_balance_after",
    "counterparty_age_s", "counterparty_is_new", "name_mismatch",
    "customer_age", "account_age_s", "income",
    "device_is_new", "session_length_s", "is_foreign_request", "email_is_free",
    "is_credit",
    "bank_txn_count_1h", "bank_amount_vs_user_mean",
    "bank_beneficiary_age_s", "bank_is_new_beneficiary",
]
CANONICAL_CATEGORICAL = [
    "event_type", "event_subtype", "protocol", "country",
    "counterparty_country", "channel", "device_os", "merchant_category",
    "currency", "payment_type",
]

# ------------------------------------------------------------- engineered ----
STATELESS_TEMPORAL = ["f_hour", "f_dayofweek", "f_is_weekend", "f_is_night",
                      "f_hour_sin", "f_hour_cos"]
STATELESS_TRANSFORM = ["f_log1p_amount", "f_log1p_bytes_in", "f_log1p_bytes_out",
                       "f_bytes_ratio"]
# Banking transforms — event-only, so offline and online agree trivially.
STATELESS_BANKING = ["f_balance_drain_ratio", "f_amount_vs_balance",
                     "f_balance_inconsistent", "f_geo_distance_km"]
STATELESS_F = [*STATELESS_TEMPORAL, *STATELESS_TRANSFORM, *STATELESS_BANKING]

# Per-user running aggregates (PAST-only: read state, emit, then advance).
USER_STATEFUL_F = ["f_user_seq_no", "f_user_secs_since_last",
                   "f_user_past_malicious_rate", "f_user_new_country",
                   "f_amount_z_user", "f_amount_ratio_mean",
                   "f_counterparty_new", "f_user_distinct_counterparties",
                   "f_merchant_category_novel", "f_user_txn_count_1h"]
DEVICE_STATEFUL_F = ["f_device_seq_no", "f_device_past_hisev_count"]
ENGINEERED_F = [*STATELESS_F, *USER_STATEFUL_F, *DEVICE_STATEFUL_F]

# Sliding window for f_user_txn_count_1h. Changing this changes CONTRACT_HASH,
# which forces a retrain — deliberate, since the feature's meaning changes.
TXN_WINDOW_S = 3600

# Offline replay of the feedback loop. `f_user_past_malicious_rate` is built
# online from labels that arrive late and incompletely via POST /feedback;
# building it offline from instant ground truth is a silent distribution shift
# that tests/unit/test_feature_parity.py cannot catch (its replay injects the
# label the moment the event is scored). When the FinSpark export supplies
# `label.confirmedAt` the real timestamp is used; these are the fallback.
LABEL_LAG_S = 7 * 86400
LABEL_CONFIRM_RATE = 0.60

# --------------------------------------------------------- shared bundles ----
TEMPORAL_F = STATELESS_TEMPORAL
USER_F = ["f_user_seq_no", "f_user_secs_since_last",
          "f_user_past_malicious_rate", "f_user_new_country"]

# Same, minus f_user_past_malicious_rate. Use this for any model that must score
# real bank traffic on day one.
#
# The feature is built offline from labels that are known instantly, but online
# it is driven by POST /feedback, which is empty until the bank has been posting
# adjudications for months. Measured on the v2 corpus: 54.0% of sparkov training
# rows have rate > 0 (fraud 0.107 vs benign 0.0054), while 100% of live traffic
# has rate == 0. The model duly learned "rate == 0 means benign" -- in an
# end-to-end check it was the single largest driver at SHAP -3.86, cancelling
# the amount signal (+3.40) and pushing an obviously fraudulent payment
# (300x the customer's normal, brand-new payee, 03:00, novel category) to a
# risk score of 0.0001.
#
# Restore it only once FinSpark supplies `label.confirmedAt` (see
# docs/finspark_export_spec.md) and the offline builder replays labels at their
# true confirmation time using LABEL_LAG_S / LABEL_CONFIRM_RATE below.
USER_F_SERVABLE = ["f_user_seq_no", "f_user_secs_since_last",
                   "f_user_new_country"]
DEVICE_F = DEVICE_STATEFUL_F

# Bank-computed signals (BANK_INTEGRATION_IMPROVEMENTS.md §3.3). Trained as an
# independent view AND used as cold-store fallback seeds; precedence is
# documented in docs/canonical_schema.md.
BANK_CONTEXT_F = ["bank_txn_count_1h", "bank_amount_vs_user_mean",
                  "bank_beneficiary_age_s", "bank_is_new_beneficiary"]

# ----------------------------------------------------------- model inputs ----
MODEL_FEATURES: dict[str, dict[str, list[str]]] = {
    # Payment path: paysim + sparkov + finspark. The only head with real user
    # sequences, so it is the only one that carries the history block.
    "fraud_payment": {
        "numeric": [
            "amount", "f_log1p_amount", "f_amount_z_user", "f_amount_ratio_mean",
            "balance_before", "balance_after",
            "counterparty_balance_before", "counterparty_balance_after",
            "f_balance_drain_ratio", "f_amount_vs_balance", "f_balance_inconsistent",
            "counterparty_age_s", "counterparty_is_new", "name_mismatch",
            "f_counterparty_new", "f_user_distinct_counterparties",
            "f_merchant_category_novel", "f_user_txn_count_1h",
            "f_geo_distance_km", "customer_age", "account_age_s",
            "device_is_new", "is_foreign_request", "is_credit",
            *USER_F_SERVABLE, *TEMPORAL_F, *BANK_CONTEXT_F,
        ],
        "categorical": ["payment_type", "channel", "merchant_category",
                        "currency", "country", "counterparty_country"],
    },
    # Application path: baf. No entity key at all, so no history block — giving
    # it one would only feed the model all-NaN columns.
    "fraud_application": {
        "numeric": ["amount", "f_log1p_amount", "duration_s", "session_length_s",
                    "income", "customer_age", "account_age_s",
                    "email_is_free", "is_foreign_request", *TEMPORAL_F],
        "categorical": ["channel", "device_os", "country"],
    },
    # FROZEN (schema v2): byte-identical to v1 so the retrained corpus does not
    # move these models. Retains f_device_past_hisev_count and its severity-derived
    # leak — documented, not fixed, because cyber is off the bank's money path.
    "cyber": {
        "numeric": ["duration_s", "bytes_in", "bytes_out", "f_log1p_bytes_in",
                    "f_log1p_bytes_out", "f_bytes_ratio", "src_port", "dst_port",
                    *USER_F, *DEVICE_F, *TEMPORAL_F],
        "categorical": ["event_type", "event_subtype", "protocol"],
    },
    # REBUILT: `country` removed. It was the #1 SHAP feature at 0.755 (8x the
    # next), but that is RBA corpus construction — label rate 0.78 for US vs 0.10
    # for NO — not account-takeover signal, and a single-country bank sees one
    # constant value. f_device_past_hisev_count dropped (severity-derived).
    "behaviour": {
        "numeric": ["duration_s", *USER_F_SERVABLE, "f_device_seq_no", *TEMPORAL_F],
        "categorical": ["event_type", "event_subtype"],
    },
    # FROZEN: byte-identical to v1.
    "quantum": {
        "numeric": ["bytes_out", "f_log1p_bytes_out", "f_device_seq_no",
                    "q_cert_age_days", "q_cert_validity_days", *TEMPORAL_F],
        "categorical": ["event_subtype", "country", "q_key_exchange",
                        "q_cert_key_type", "q_data_class"],
    },
}

FROZEN_MODELS = frozenset({"cyber", "quantum"})

# -------------------------------------------------------------- routing ------
# (event_domain, event_type) -> model key; falls back to the domain default.
# v1 routed on event_domain alone, which forced one fraud model to serve both
# payments and account applications — `event_type` was its #2 SHAP feature at
# 0.477, i.e. capacity spent recovering that split instead of detecting fraud.
DOMAIN_DEFAULT_MODEL = {
    "financial": "fraud_payment",
    "cyber": "cyber",
    "behaviour": "behaviour",
    "quantum": "quantum",
}
EVENT_TYPE_MODEL = {
    ("financial", "account_open"): "fraud_application",
}

# Training-source assignment. creditcard is deliberately absent: under the
# servability rule its entire signal is V1..V28 (PCA of undisclosed features that
# no bank can send), leaving only amount + timestamp, so 150k near-featureless
# rows at a 0.17% positive rate would add label noise and nothing else.
MODEL_SOURCES = {
    "fraud_payment": ["sparkov", "finspark"],
    "fraud_application": ["baf"],
    "cyber": ["unsw_nb15", "beth", "cicids2017"],
    "behaviour": ["rba", "cert_insider"],
    "quantum": ["quantum_synth"],
}
EXCLUDED_SOURCES = {
    "creditcard":
        "Servability: its entire signal is V1..V28, PCA components of undisclosed "
        "features that no bank can reconstruct or send. What remains canonical is "
        "amount + timestamp, so 150k rows at a 0.17% positive rate add label noise "
        "and nothing else. See docs/canonical_schema.md.",
    "paysim":
        "Label alias via the balance columns. Measured on the v2 corpus: the "
        "predicate (balance_before == amount AND balance_after == 0) fires on "
        "8,024 rows with ZERO false positives and 97.7% recall -- it IS the "
        "simulator's fraud-generating rule. Promoting the balances out of "
        "`attributes` (correct in general) made that rule visible, and a head "
        "trained with paysim scored a fake ROC-AUC of 1.0000 on it. The behaviour "
        "will not transfer: real fraudsters do not reliably zero an account and "
        "real balance feeds are noisy. paysim also has 1.0 events/user, so it "
        "contributes no sequences either. The balance FEATURES stay in the "
        "contract -- drain-ratio is a genuine bank-servable signal and FinSpark "
        "supplies it honestly; it is this source that is dropped.",
}


def route(event_domain: str, event_type: str | None = None) -> str | None:
    """Model key for an event, or None when no model covers it (threat_intel)."""
    key = EVENT_TYPE_MODEL.get((event_domain, event_type))
    return key if key is not None else DOMAIN_DEFAULT_MODEL.get(event_domain)


def model_columns(model_key: str) -> list[str]:
    spec = MODEL_FEATURES[model_key]
    return [*spec["numeric"], *spec["categorical"]]


# ---------------------------------------------------------------- hash -------
def _contract_payload() -> dict:
    return {
        "canonical_numeric": CANONICAL_NUMERIC,
        "canonical_categorical": CANONICAL_CATEGORICAL,
        "engineered": ENGINEERED_F,
        "model_features": MODEL_FEATURES,
        "routing": {"domain": DOMAIN_DEFAULT_MODEL,
                    "event_type": {f"{d}|{t}": m for (d, t), m in EVENT_TYPE_MODEL.items()}},
        "txn_window_s": TXN_WINDOW_S,
        "label_lag_s": LABEL_LAG_S,
        "label_confirm_rate": LABEL_CONFIRM_RATE,
    }


def contract_hash() -> str:
    blob = json.dumps(_contract_payload(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


CONTRACT_HASH = contract_hash()
