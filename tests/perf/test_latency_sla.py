"""Inference latency SLAs on REAL artifacts (reference box: 12-core CPU).
Budgets deliberately generous — hard regression catching, not micro-benching."""
import time

import joblib
import pytest

from ml.config import SLA
from ml.evaluate import latency_benchmark
from ml.features import CategoryEncoder, build_matrix, impute

pytestmark = pytest.mark.perf


@pytest.fixture(scope="module")
def matrices(real_artifacts, fixture_frame):
    out = {}
    domain = {"fraud_payment": "financial", "fraud_application": "financial",
              "cyber": "cyber",
              "behaviour": "behaviour", "quantum": "quantum"}
    for key, dom in domain.items():
        bundle = joblib.load(real_artifacts / f"{key}_bundle.joblib")
        rows = fixture_frame[fixture_frame["event_domain"] == dom].head(10_000)
        X, _ = build_matrix(rows, key, CategoryEncoder(bundle["encoder_mapping"]))
        X = X[bundle["features"]]
        if bundle["medians"] is not None:
            X = impute(X, bundle["medians"])
        out[key] = (bundle["model"], X)
    return out


@pytest.mark.parametrize("key", ["fraud_payment", "fraud_application",
                                 "cyber", "quantum"])
def test_gbm_single_row_p50(matrices, key):
    model, X = matrices[key]
    lat = latency_benchmark(model, X)
    assert lat["single_row_ms"]["p50"] < SLA["gbm_single_row_ms_p50"]


def test_iforest_single_row_p50(matrices):
    model, X = matrices["behaviour"]
    lat = latency_benchmark(model, X)
    assert lat["single_row_ms"]["p50"] < SLA["iforest_single_row_ms_p50"]


@pytest.mark.parametrize("key", ["fraud_payment", "fraud_application",
                                 "cyber", "behaviour", "quantum"])
def test_batch_throughput(matrices, key):
    model, X = matrices[key]
    lat = latency_benchmark(model, X)
    assert lat["batch_rows_per_sec"] > SLA["batch_rows_per_sec_min"]


def test_scorer_cold_start(real_artifacts):
    from ml.predict import SentinelScorer
    t0 = time.perf_counter()
    SentinelScorer(real_artifacts)
    assert time.perf_counter() - t0 < SLA["scorer_cold_start_s"]
