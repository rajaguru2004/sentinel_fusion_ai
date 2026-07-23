import numpy as np
import pandas as pd

from ml.config import FEATURES
from ml.features import build_matrix, fit_imputer, impute


def test_medians_and_allnan_column():
    X = pd.DataFrame({"a": [1.0, 3.0, np.nan], "b": [np.nan, np.nan, np.nan]},
                     dtype="float32")
    med = fit_imputer(X)
    assert med["a"] == 2.0
    assert med["b"] == 0.0  # all-NaN column falls back to 0.0


def test_impute_leaves_no_nan():
    X = pd.DataFrame({"a": [1.0, np.nan], "b": [np.nan, np.nan]}, dtype="float32")
    out = impute(X, fit_imputer(X))
    assert not out.isna().any().any()


def test_build_matrix_column_order_matches_spec(fixture_frame):
    fin = fixture_frame[fixture_frame["event_domain"] == "financial"]
    X, _ = build_matrix(fin, "fraud_payment")
    spec = FEATURES["fraud_payment"]
    assert list(X.columns) == spec["numeric"] + spec["categorical"]


def test_missing_numeric_column_becomes_nan_column(fixture_frame):
    fin = fixture_frame[fixture_frame["event_domain"] == "financial"].drop(
        columns=["amount"])
    X, _ = build_matrix(fin, "fraud_payment")
    assert X["amount"].isna().all()


def test_matrix_reuses_frozen_encoder(fixture_frame):
    fin = fixture_frame[fixture_frame["event_domain"] == "financial"]
    _, enc = build_matrix(fin.iloc[:100], "fraud_payment")
    frozen = dict(enc.mapping)
    build_matrix(fin.iloc[100:200], "fraud_payment", enc)
    assert enc.mapping == frozen  # transform must not refit
