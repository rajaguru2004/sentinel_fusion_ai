"""Plain-language reason templates for SHAP attributions (requirements §4.2).

`/score?explain=true` returns internal names — `f_log1p_amount`,
`f_user_seq_no` — which are useless in an analyst feed or a risk badge. This
maps the top attributions onto sentences that read like the bank's own heuristic
output ("amount is 12x this customer's normal", "beneficiary added 5 minutes
ago").

Rules:
* Only features that pushed the score UP are described. A negative SHAP means
  "this looked normal", which is not a reason to flag anything.
* A template renders only when its value is present and meaningful; a NaN or an
  absent field yields no sentence rather than "amount is nan x normal".
* Unknown features fall back to a readable label, so adding a feature to the
  contract degrades to something sane instead of leaking `f_*` to an analyst.
"""
from __future__ import annotations

import math
from typing import Any, Callable

_NAMES = {
    "amount": "transaction amount",
    "f_log1p_amount": "transaction amount",
    "f_hour": "time of day",
    "f_hour_sin": "time of day",
    "f_hour_cos": "time of day",
    "f_is_night": "overnight activity",
    "f_is_weekend": "weekend activity",
    "f_dayofweek": "day of week",
    "merchant_category": "merchant category",
    "payment_type": "payment type",
    "channel": "channel",
    "country": "country",
    "counterparty_country": "beneficiary country",
    "currency": "currency",
    "device_os": "device operating system",
    "customer_age": "customer age",
    "account_age_s": "account age",
    "income": "declared income",
    "session_length_s": "session length",
    "f_user_seq_no": "customer history depth",
    "f_user_secs_since_last": "time since previous activity",
    "f_user_new_country": "new country for this customer",
    "f_user_distinct_counterparties": "number of known payees",
    "f_geo_distance_km": "distance to counterparty",
    "balance_before": "balance before the transaction",
    "counterparty_balance_before": "beneficiary balance",
}


def _fmt_duration(seconds: float) -> str:
    s = abs(float(seconds))
    if s < 90:
        return f"{s:.0f} seconds"
    if s < 5400:
        return f"{s / 60:.0f} minutes"
    if s < 172800:
        return f"{s / 3600:.0f} hours"
    return f"{s / 86400:.0f} days"


def _ratio(v: float) -> str | None:
    if v is None or math.isnan(v) or v <= 1.2:
        return None
    return f"amount is {v:.0f}x this customer's normal spend"


def _zscore(v: float) -> str | None:
    if v is None or math.isnan(v) or v <= 2:
        return None
    # A customer whose past spend is near-constant produces an enormous z (a
    # tiny denominator), and "5318.4 standard deviations" reads as a bug rather
    # than a finding. Past ~20 sigma the exact figure carries no extra meaning.
    if v > 20:
        return "amount is far outside this customer's usual range"
    return f"amount is {v:.1f} standard deviations above this customer's usual"


def _velocity(v: float) -> str | None:
    if v is None or math.isnan(v) or v < 2:
        return None
    return f"{int(v)} transactions by this customer in the past hour"


def _beneficiary_age(v: float) -> str | None:
    if v is None or math.isnan(v):
        return None
    return f"beneficiary was added {_fmt_duration(v)} ago"

# feature -> (value -> sentence | None)
_TEMPLATES: dict[str, Callable[[Any], str | None]] = {
    "f_amount_ratio_mean": _ratio,
    "bank_amount_vs_user_mean": _ratio,
    "f_amount_z_user": _zscore,
    "f_user_txn_count_1h": _velocity,
    "bank_txn_count_1h": _velocity,
    "counterparty_age_s": _beneficiary_age,
    "bank_beneficiary_age_s": _beneficiary_age,
    "f_counterparty_new": lambda v: (
        "first ever payment to this beneficiary" if v == 1 else None),
    "counterparty_is_new": lambda v: (
        "beneficiary is new to this customer" if v == 1 else None),
    "bank_is_new_beneficiary": lambda v: (
        "beneficiary is new to this customer" if v == 1 else None),
    "name_mismatch": lambda v: (
        "beneficiary name does not match the account holder" if v == 1 else None),
    "f_merchant_category_novel": lambda v: (
        "first purchase by this customer in this merchant category"
        if v == 1 else None),
    "f_user_new_country": lambda v: (
        "first activity from this country for this customer" if v == 1 else None),
    "f_is_night": lambda v: ("activity between midnight and 6am" if v == 1 else None),
    "is_foreign_request": lambda v: ("request originated abroad" if v == 1 else None),
    "device_is_new": lambda v: ("device not seen before for this customer"
                                if v == 1 else None),
    "email_is_free": lambda v: ("free email provider" if v == 1 else None),
    "f_balance_drain_ratio": lambda v: (
        None if v is None or math.isnan(v) or v < 0.9
        else "transaction empties almost the whole balance"),
    "f_balance_inconsistent": lambda v: (
        "balance does not reconcile with the amount" if v == 1 else None),
    "f_amount_vs_balance": lambda v: (
        None if v is None or math.isnan(v) or v < 0.5
        else f"amount is {v * 100:.0f}% of the available balance"),
    "f_user_seq_no": lambda v: (
        "customer has little prior history" if v is not None
        and not math.isnan(v) and v < 5 else None),
}


# Features that describe the SAME underlying fact. Several exist twice by
# design — the store-computed `f_*` and the bank's own `bank_*` view — and
# emitting both produces contradictory sentences in the analyst feed ("8
# transactions in the past hour" next to "2 transactions in the past hour").
# One reason per concept; the store-computed value wins, matching the
# precedence documented in docs/canonical_schema.md.
_CONCEPT = {
    "f_user_txn_count_1h": "velocity",
    "bank_txn_count_1h": "velocity",
    "f_amount_ratio_mean": "amount_vs_normal",
    "bank_amount_vs_user_mean": "amount_vs_normal",
    "f_amount_z_user": "amount_vs_normal",
    "counterparty_age_s": "beneficiary_age",
    "bank_beneficiary_age_s": "beneficiary_age",
    "f_counterparty_new": "beneficiary_new",
    "counterparty_is_new": "beneficiary_new",
    "bank_is_new_beneficiary": "beneficiary_new",
    "amount": "amount_size",
    "f_log1p_amount": "amount_size",
    "f_hour": "time_of_day",
    "f_hour_sin": "time_of_day",
    "f_hour_cos": "time_of_day",
    "f_is_night": "time_of_day",
}


def _prefer(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """Which of two attributions for the same concept to describe."""
    a_store = str(a.get("feature", "")).startswith("f_")
    b_store = str(b.get("feature", "")).startswith("f_")
    if a_store != b_store:
        return a if a_store else b
    return a if abs(float(a.get("shap") or 0)) >= abs(float(b.get("shap") or 0)) else b


def _render(name: str, value: Any) -> str | None:
    tmpl = _TEMPLATES.get(name)
    if tmpl is None or value is None:
        return None
    try:
        return tmpl(float(value))
    except (TypeError, ValueError):
        return None


def describe(attributions: list[dict[str, Any]], *, limit: int = 4) -> list[str]:
    """Plain-language reasons for the attributions that RAISED the score.

    Two passes, because the most *explainable* feature is often not the highest
    SHAP one. "amount" ranks top and yields only "unusual transaction amount",
    while `f_amount_ratio_mean` sits lower yet renders "amount is 12x this
    customer's normal spend" — which is what an analyst actually needs.

    So: specific templates first (over every positively-contributing feature,
    ordered by SHAP), then generic labels for the strongest remaining drivers
    only if there is still room. Anything with no safe wording is skipped rather
    than leaking an `f_*` name into the analyst feed.
    """
    pos = sorted((f for f in attributions if float(f.get("shap") or 0.0) > 0),
                 key=lambda f: -float(f.get("shap") or 0.0))

    # Collapse duplicate views of the same fact, keeping each concept's first
    # (highest-SHAP) appearance so ordering is preserved.
    chosen: dict[str, dict[str, Any]] = {}
    for f in pos:
        c = _CONCEPT.get(f.get("feature"))
        if c is None:
            continue
        chosen[c] = _prefer(chosen[c], f) if c in chosen else f
    pos = [f for f in pos
           if _CONCEPT.get(f.get("feature")) is None
           or chosen.get(_CONCEPT[f["feature"]]) is f]

    out: list[str] = []

    for f in pos:                                  # pass 1 — specific
        text = _render(f.get("feature"), f.get("value"))
        if text and text not in out:
            out.append(text)
        if len(out) >= limit:
            return out

    # Pass 2 — generic fallbacks, ONLY to pad out an event that already has a
    # concrete finding. On benign traffic every feature still has some positive
    # SHAP, and emitting "unusual customer age" for a routine grocery purchase
    # invents a narrative the analyst then has to disprove. No specific reason
    # means there is genuinely nothing notable to report.
    if not out:
        return out
    for f in pos:
        if _render(f.get("feature"), f.get("value")):
            continue                               # already covered above
        label = _NAMES.get(f.get("feature"))
        if label is None:
            continue
        text = f"unusual {label}"
        if text not in out:
            out.append(text)
        if len(out) >= limit:
            break
    return out
