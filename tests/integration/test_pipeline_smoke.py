import json

import numpy as np

from ml.data import temporal_split
from ml.run_pipeline import MODEL_LIB, train_one


def test_pipeline_artifacts_complete(mini_artifacts):
    for key in MODEL_LIB:
        assert (mini_artifacts / f"{key}_bundle.joblib").exists()
    assert (mini_artifacts / "fraud_xgb.json").exists()
    assert (mini_artifacts / "cyber_lgbm.txt").exists()
    assert (mini_artifacts / "quantum_xgb.json").exists()
    assert (mini_artifacts / "fusion_engine.joblib").exists()
    assert (mini_artifacts / "reference_stats.json").exists()
    reports = mini_artifacts.parent / "reports"
    metrics = json.loads((reports / "metrics_all.json").read_text())
    assert set(MODEL_LIB) <= set(metrics)
    assert "fusion" in metrics


def test_supervised_models_learn_signal(mini_artifacts):
    reports = mini_artifacts.parent / "reports"
    metrics = json.loads((reports / "metrics_all.json").read_text())
    for key in ["fraud", "cyber", "quantum"]:
        assert metrics[key]["test"]["roc_auc"] > 0.6, key


def test_pipeline_rerun_identical_scores(fixture_frame, tmp_path):
    """Seed pin: same data + same seed -> byte-identical val scores."""
    split = temporal_split(fixture_frame)
    kw = dict(fast=True, skip_shap=True)
    r1 = train_one("fraud", fixture_frame, split, models_dir=tmp_path,
                   reports_dir=tmp_path, **kw)
    r2 = train_one("fraud", fixture_frame, split, models_dir=tmp_path,
                   reports_dir=tmp_path, **kw)
    np.testing.assert_allclose(r1["s_va"], r2["s_va"], atol=1e-9)
