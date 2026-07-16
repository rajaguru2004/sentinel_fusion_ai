"""Accuracy gates against REAL trained models + full corpus.
Floors live in benchmarks/baselines/metrics_baseline.json — single source of
truth shared with `ml.benchmark --check`. Skipped when artifacts absent."""
import json

import pytest

from ml.config import BENCH_DIR

pytestmark = pytest.mark.quality

BASELINE = BENCH_DIR / "baselines" / "metrics_baseline.json"


@pytest.fixture(scope="module")
def floors():
    if not BASELINE.exists():
        pytest.skip("no committed baseline yet")
    return json.loads(BASELINE.read_text())


@pytest.fixture(scope="module")
def current(real_artifacts):
    from ml.config import ML_REPORTS
    p = ML_REPORTS / "metrics_all.json"
    if not p.exists():
        pytest.skip("no metrics_all.json — run the pipeline first")
    return json.loads(p.read_text())


@pytest.mark.parametrize("key", ["fraud", "cyber", "behaviour", "quantum"])
def test_auc_floor(floors, current, key):
    assert current[key]["test"]["roc_auc"] >= floors[key]["roc_auc"]["min"]


@pytest.mark.parametrize("key", ["fraud", "cyber", "behaviour", "quantum"])
def test_f1_floor(floors, current, key):
    assert current[key]["test"]["f1"] >= floors[key]["f1"]["min"]


def test_fusion_auc_floor(floors, current):
    assert (current["fusion"]["cross_domain_roc_auc"]
            >= floors["fusion"]["cross_domain_roc_auc"]["min"])


def test_thresholds_sane(current):
    for key in ["fraud", "cyber", "quantum"]:
        assert 0.0 < current[key]["threshold_val_maxF1"] < 1.0, key
