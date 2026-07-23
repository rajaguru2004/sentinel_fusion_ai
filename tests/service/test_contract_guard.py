"""CONTRACT_HASH startup enforcement.

This is the mechanism that makes "training and serving share one feature
contract" enforceable rather than aspirational: `ml/feature_spec.py`
fingerprints the canonical columns, engineered features, per-model inputs and
routing; every bundle records the hash it was trained under; the service refuses
to start on a mismatch.

Without it, editing a feature list without retraining silently mis-scores every
request — the exact class of skew this schema revision exists to remove.
"""
from __future__ import annotations

import shutil

import joblib
import pytest

from ml.feature_spec import CONTRACT_HASH
from service.app import check_contract
from service.scorer_service import ScorerService


def test_matching_contract_starts(mini_artifacts):
    check_contract(ScorerService(mini_artifacts))       # must not raise


def test_mismatched_contract_refuses_to_start(mini_artifacts, tmp_path):
    for f in mini_artifacts.iterdir():
        if f.is_file():
            shutil.copy(f, tmp_path / f.name)
    target = tmp_path / "fraud_payment_bundle.joblib"
    bundle = joblib.load(target)
    bundle["contract_hash"] = "deadbeefdeadbeef"
    joblib.dump(bundle, target, compress=3)

    with pytest.raises(RuntimeError, match="feature-contract mismatch"):
        check_contract(ScorerService(tmp_path))


def test_legacy_bundle_without_hash_is_allowed(mini_artifacts, tmp_path, caplog):
    """Pre-v2 artifacts must stay loadable so a rollback target still works."""
    for f in mini_artifacts.iterdir():
        if f.is_file():
            shutil.copy(f, tmp_path / f.name)
    target = tmp_path / "fraud_payment_bundle.joblib"
    bundle = joblib.load(target)
    bundle.pop("contract_hash", None)
    joblib.dump(bundle, target, compress=3)

    check_contract(ScorerService(tmp_path))             # warns, does not raise
    assert "predate CONTRACT_HASH" in caplog.text


def test_bundles_record_the_current_hash(mini_artifacts):
    for key in ("fraud_payment", "fraud_application", "cyber", "behaviour", "quantum"):
        b = joblib.load(mini_artifacts / f"{key}_bundle.joblib")
        assert b["contract_hash"] == CONTRACT_HASH, key
