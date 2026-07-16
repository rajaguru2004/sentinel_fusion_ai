import pandas as pd

from ml.config import TRAIN_FRAC, VAL_FRAC
from ml.data import domain_slice, temporal_split


def test_split_fractions_within_tolerance_per_source(fixture_frame, fixture_split):
    for src, g in fixture_frame.groupby("source_dataset", observed=True):
        n = len(g)
        parts = fixture_split.loc[g.index].value_counts()
        assert abs(parts.get("train", 0) - int(n * TRAIN_FRAC)) <= 1, src
        assert abs(parts.get("val", 0)
                   - (int(n * (TRAIN_FRAC + VAL_FRAC)) - int(n * TRAIN_FRAC))) <= 1, src


def test_no_overlap_between_splits(fixture_frame, fixture_split):
    assert set(fixture_split.unique()) <= {"train", "val", "test"}
    assert len(fixture_split) == len(fixture_frame)  # every row assigned exactly once


def test_temporal_ordering_within_source(fixture_frame, fixture_split):
    for src, g in fixture_frame.groupby("source_dataset", observed=True):
        s = fixture_split.loc[g.index]
        t = g["event_time"]
        for earlier, later in [("train", "val"), ("val", "test"), ("train", "test")]:
            a, b = t[s == earlier], t[s == later]
            if len(a) and len(b):
                assert a.max() <= b.min(), src  # <= : boundary ties legal


def test_split_deterministic_across_calls(fixture_frame, fixture_split):
    pd.testing.assert_series_equal(fixture_split, temporal_split(fixture_frame))


def test_leak_scrub_nulls_subtype_for_unsw_and_cicids(fixture_frame):
    leak = fixture_frame["source_dataset"].isin(["unsw_nb15", "cicids2017"])
    assert leak.any()
    assert fixture_frame.loc[leak, "event_subtype"].isna().all()


def test_leak_scrub_preserves_beth_syscalls(fixture_frame):
    beth = fixture_frame[fixture_frame["source_dataset"] == "beth"]
    assert beth["event_subtype"].notna().any()


def test_domain_slice_labeled_only_drops_minus1(fixture_frame, fixture_split):
    all_rows = domain_slice(fixture_frame, fixture_split, "behaviour", "train",
                            labeled_only=False)
    labeled = domain_slice(fixture_frame, fixture_split, "behaviour", "train",
                           labeled_only=True)
    assert (all_rows["label"] == -1).any()          # cert_insider present
    assert (labeled["label"] >= 0).all()


def test_quantum_join_adds_q_columns(fixture_frame):
    q = fixture_frame[fixture_frame["event_domain"] == "quantum"]
    rest = fixture_frame[fixture_frame["event_domain"] != "quantum"]
    for c in ["q_key_exchange", "q_cert_key_type", "q_data_class",
              "q_cert_age_days", "q_cert_validity_days"]:
        assert q[c].notna().all(), c
        assert rest[c].isna().all(), c
