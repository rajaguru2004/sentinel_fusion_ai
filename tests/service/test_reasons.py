"""Plain-language reason templates (requirements §4.2)."""
from __future__ import annotations

from service.reasons import describe


def _a(feature, value, shap):
    return {"feature": feature, "value": value, "shap": shap}


def test_specific_templates_beat_generic_labels():
    """The most explainable feature is often not the highest-SHAP one."""
    out = describe([
        _a("amount", 9000.0, 3.0),                 # generic only
        _a("f_amount_ratio_mean", 12.0, 0.4),      # specific, ranks lower
        _a("f_counterparty_new", 1.0, 0.3),
    ])
    assert "amount is 12x this customer's normal spend" in out
    assert "first ever payment to this beneficiary" in out


def test_negative_shap_is_not_a_reason():
    """A feature that pushed the score DOWN did not cause the flag."""
    assert describe([_a("f_counterparty_new", 1.0, -2.0)]) == []


def test_no_generic_narrative_without_a_concrete_finding():
    """Benign traffic must not get invented reasons.

    Every feature carries some positive SHAP, so padding with 'unusual customer
    age' on a routine purchase gives the analyst something to disprove rather
    than something to act on.
    """
    assert describe([_a("customer_age", 41.0, 0.2), _a("channel", 1.0, 0.1)]) == []


def test_absurd_zscore_is_capped():
    """A near-constant spender yields a huge z; the figure stops being useful."""
    out = describe([_a("f_amount_z_user", 5318.4, 2.0)])
    assert out == ["amount is far outside this customer's usual range"]
    assert describe([_a("f_amount_z_user", 4.2, 2.0)]) == [
        "amount is 4.2 standard deviations above this customer's usual"]


def test_never_leaks_internal_feature_names():
    out = describe([_a("f_some_unmapped_feature", 1.0, 5.0),
                    _a("f_counterparty_new", 1.0, 0.1)])
    assert all("f_" not in r for r in out), out


def test_beneficiary_age_is_humanised():
    assert describe([_a("counterparty_age_s", 300.0, 1.0)]) == [
        "beneficiary was added 5 minutes ago"]


def test_one_reason_per_concept():
    """Store-computed and bank-provided views of the same fact must not both
    render — they produce contradictory sentences in the analyst feed."""
    out = describe([
        _a("bank_txn_count_1h", 8.0, 3.0),
        _a("f_user_txn_count_1h", 2.0, 1.0),
        _a("f_counterparty_new", 1.0, 0.5),
    ])
    velocity = [r for r in out if "past hour" in r]
    assert len(velocity) == 1, out
    # documented precedence: the store-computed value wins
    assert velocity[0] == "2 transactions by this customer in the past hour"


def test_amount_views_collapse_to_one_reason():
    out = describe([
        _a("f_amount_ratio_mean", 12.0, 2.0),
        _a("bank_amount_vs_user_mean", 40.0, 1.5),
        _a("f_amount_z_user", 30.0, 1.0),
    ])
    assert len(out) == 1, out
