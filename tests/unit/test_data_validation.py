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
    assert len(full_frame) == 2_043_664


@pytest.mark.slow
def test_full_corpus_invariants(full_frame):
    assert full_frame["event_id"].is_unique
    assert set(full_frame["label"].unique()) <= {-1, 0, 1}
