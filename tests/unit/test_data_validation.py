import pytest

from ml.config import DOMAIN_OF_MODEL, FEATURES
from ml.data import needed_columns

LEAKY = {"severity", "label", "label_type", "source_dataset", "sampling_weight",
         "event_id", "attack_technique"}


def test_no_leaky_columns_in_any_feature_spec():
    for key, spec in FEATURES.items():
        used = set(spec["numeric"]) | set(spec["categorical"])
        assert not (used & LEAKY), f"{key} uses leaky columns: {used & LEAKY}"


def test_required_columns_present(fixture_frame):
    assert set(needed_columns()) <= set(fixture_frame.columns)


def test_label_values(fixture_frame):
    assert set(fixture_frame["label"].unique()) <= {-1, 0, 1}


def test_domains_expected_set(fixture_frame):
    assert set(fixture_frame["event_domain"].unique()) <= {
        "cyber", "financial", "behaviour", "threat_intel", "quantum"}
    assert set(DOMAIN_OF_MODEL.values()) <= set(fixture_frame["event_domain"].unique())


def test_sampling_weight_positive(fixture_frame):
    w = fixture_frame["sampling_weight"].dropna()
    assert (w > 0).all()


def test_event_time_utc(fixture_frame):
    assert str(fixture_frame["event_time"].dt.tz) == "UTC"


def test_event_id_unique(fixture_frame):
    assert fixture_frame["event_id"].is_unique


@pytest.mark.slow
def test_full_corpus_row_count(full_frame):
    # schema v2: 2,043,664 -> 3,896,058 (Sparkov kept whole rather than
    # row-sampled, because sampling is what destroyed per-user sequences)
    # -> 4,006,719 with the FinSpark conformance export.
    assert len(full_frame) == 4_006_719


@pytest.mark.slow
def test_full_corpus_invariants(full_frame):
    assert full_frame["event_id"].is_unique
    assert set(full_frame["label"].unique()) <= {-1, 0, 1}


@pytest.mark.slow
def test_financial_rows_have_user_history(full_frame):
    """The v1 regression, pinned.

    Every fraud training row had f_user_seq_no = 0/NaN because row-level
    sampling shattered per-customer sequences, so the four history features the
    bank integration depends on scored mean |SHAP| exactly 0.0. If this floor
    ever fails again, check NO_SAMPLE in notebooks/src/11_unify.py before
    touching the models.
    """
    fin = full_frame[full_frame["event_domain"] == "financial"]
    share = float((fin["f_user_seq_no"] > 0).mean())
    assert share >= 0.40, f"only {share:.1%} of financial rows carry user history"
