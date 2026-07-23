import numpy as np
import pandas as pd
import pytest

OUT_COLS = {"model", "raw_score", "p_fraud_payment", "p_fraud_application",
            "p_cyber", "p_behaviour",
            "p_quantum", "risk_score", "risk_level", "scored"}
LEVELS = {"low", "medium", "high", "critical"}


def _domain_rows(fixture_frame, domain, n=1):
    return fixture_frame[fixture_frame["event_domain"] == domain].head(n)


def test_empty_dataframe(scorer, fixture_frame):
    out = scorer.score_events(fixture_frame.head(0))
    assert len(out) == 0
    assert OUT_COLS <= set(out.columns)


def test_missing_event_domain_clean_error(scorer):
    with pytest.raises(ValueError, match="event_domain"):
        scorer.score_events(pd.DataFrame({"amount": [1.0]}))


@pytest.mark.parametrize("domain,expected_model", [
    ("financial", "fraud_payment"), ("cyber", "cyber"),
    ("behaviour", "behaviour"), ("quantum", "quantum")])
def test_single_row_routing(scorer, fixture_frame, domain, expected_model):
    out = scorer.score_events(_domain_rows(fixture_frame, domain))
    assert out["model"].iloc[0] == expected_model
    assert out["scored"].iloc[0]
    assert np.isfinite(out["risk_score"].iloc[0])
    assert out["risk_level"].iloc[0] in LEVELS


def test_threat_intel_rows_unscored(scorer, fixture_frame):
    out = scorer.score_events(_domain_rows(fixture_frame, "threat_intel", 3))
    assert (~out["scored"]).all()
    assert (out["risk_score"] == 0.0).all()
    assert (out["risk_level"] == "low").all()
    assert out["model"].isna().all()


def test_all_nan_numeric_row_scores_finite(scorer, fixture_frame):
    row = _domain_rows(fixture_frame, "financial").copy()
    for c in row.columns:
        if row[c].dtype.kind == "f":
            row[c] = np.nan
    out = scorer.score_events(row)
    assert np.isfinite(out["risk_score"].iloc[0])


def test_unseen_categories_score_finite(scorer, fixture_frame):
    row = _domain_rows(fixture_frame, "cyber").copy()
    row["protocol"] = "quic-v99"
    row["event_type"] = "alien_flow"
    out = scorer.score_events(row)
    assert np.isfinite(out["risk_score"].iloc[0])


def test_missing_optional_columns_ok(scorer, fixture_frame):
    rows = _domain_rows(fixture_frame, "financial", 5).drop(
        columns=["country", "duration_s"], errors="ignore")
    out = scorer.score_events(rows)
    assert np.isfinite(out["risk_score"]).all()


def test_mixed_domains_batch(scorer, fixture_frame):
    mixed = pd.concat([_domain_rows(fixture_frame, d, 2) for d in
                       ["financial", "cyber", "behaviour", "quantum", "threat_intel"]])
    out = scorer.score_events(mixed)
    assert len(out) == len(mixed)
    assert out.loc[out["scored"], "model"].notna().all()


def test_scoring_deterministic(scorer, fixture_frame):
    rows = fixture_frame.head(50)
    a, b = scorer.score_events(rows), scorer.score_events(rows)
    pd.testing.assert_frame_equal(a, b)


def test_risk_score_in_unit_interval(scorer, fixture_frame):
    out = scorer.score_events(fixture_frame.head(500))
    assert out["risk_score"].between(0, 1).all()
