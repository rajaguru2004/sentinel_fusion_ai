"""Serialization integrity on REAL artifacts: the pickle-free native boosters
must produce identical scores to the joblib bundles they mirror."""
import joblib
import numpy as np
import pytest

from ml.features import CategoryEncoder, build_matrix, impute

pytestmark = pytest.mark.quality

BUNDLE_KEYS = {"model", "features", "encoder_mapping", "medians",
               "threshold", "library", "seed"}


@pytest.fixture(scope="module")
def sample(fixture_frame):
    return fixture_frame


def _matrix(bundle, df, key):
    domain = {"fraud_payment": "financial", "fraud_application": "financial",
              "cyber": "cyber",
              "behaviour": "behaviour", "quantum": "quantum"}[key]
    rows = df[df["event_domain"] == domain].head(1000)
    X, _ = build_matrix(rows, key, CategoryEncoder(bundle["encoder_mapping"]))
    X = X[bundle["features"]]
    if bundle["medians"] is not None:
        X = impute(X, bundle["medians"])
    return X


@pytest.mark.parametrize("key", ["fraud_payment", "fraud_application", "quantum"])
def test_xgb_bundle_vs_native_json_parity(real_artifacts, sample, key):
    import xgboost as xgb
    bundle = joblib.load(real_artifacts / f"{key}_bundle.joblib")
    X = _matrix(bundle, sample, key)
    booster = xgb.Booster(model_file=str(real_artifacts / f"{key}_xgb.json"))
    native = booster.predict(xgb.DMatrix(X))
    wrapped = bundle["model"].predict_proba(X)[:, 1]
    np.testing.assert_allclose(native, wrapped, atol=1e-6)


def test_lgbm_bundle_vs_native_txt_parity(real_artifacts, sample):
    import lightgbm as lgb
    bundle = joblib.load(real_artifacts / "cyber_bundle.joblib")
    X = _matrix(bundle, sample, "cyber")
    booster = lgb.Booster(model_file=str(real_artifacts / "cyber_lgbm.txt"))
    native = booster.predict(X)
    wrapped = bundle["model"].predict_proba(X)[:, 1]
    np.testing.assert_allclose(native, wrapped, atol=1e-6)


@pytest.mark.parametrize("key", ["fraud_payment", "fraud_application",
                                 "cyber", "behaviour", "quantum"])
def test_bundle_contains_required_keys(real_artifacts, key):
    bundle = joblib.load(real_artifacts / f"{key}_bundle.joblib")
    assert BUNDLE_KEYS <= set(bundle)
    assert bundle["seed"] == 42


def test_bundle_joblib_roundtrip(real_artifacts, sample, tmp_path):
    bundle = joblib.load(real_artifacts / "fraud_payment_bundle.joblib")
    X = _matrix(bundle, sample, "fraud_payment")
    joblib.dump(bundle, tmp_path / "b.joblib", compress=3)
    clone = joblib.load(tmp_path / "b.joblib")
    np.testing.assert_allclose(bundle["model"].predict_proba(X)[:, 1],
                               clone["model"].predict_proba(X)[:, 1], atol=0)


def test_fusion_engine_roundtrip(real_artifacts, tmp_path):
    eng = joblib.load(real_artifacts / "fusion_engine.joblib")
    joblib.dump(eng, tmp_path / "f.joblib")
    clone = joblib.load(tmp_path / "f.joblib")
    for s in [0.1, 0.5, 0.9]:
        assert eng.fuse({"fraud_payment": s}) == clone.fuse({"fraud_payment": s})
