import numpy as np
import pytest

from ml.evaluate import (
    brier_score,
    compute_metrics,
    expected_calibration_error,
    pick_threshold,
    pick_threshold_cost,
)


def test_pick_threshold_maximizes_f1_on_toy():
    y = np.array([0, 0, 0, 1, 1, 1])
    s = np.array([0.1, 0.2, 0.8, 0.7, 0.9, 0.95])
    t = pick_threshold(y, s)
    # threshold 0.7: P=3/4, R=1, F1=0.857 — beats any higher/lower cut
    assert t == pytest.approx(0.7)


def test_pick_threshold_degenerate_single_class_no_crash():
    assert isinstance(pick_threshold(np.zeros(5, dtype=int), np.full(5, 0.3)), float)


def test_compute_metrics_matches_manual_confusion():
    y = np.array([0, 0, 1, 1, 1, 0])
    s = np.array([0.1, 0.9, 0.8, 0.2, 0.7, 0.3])
    m = compute_metrics(y, s, threshold=0.5)
    assert m["confusion_matrix"] == {"tn": 2.0, "fp": 1.0, "fn": 1.0, "tp": 2.0}
    assert m["accuracy"] == pytest.approx(4 / 6, abs=1e-4)
    assert m["precision"] == pytest.approx(2 / 3, abs=1e-4)
    assert m["recall"] == pytest.approx(2 / 3, abs=1e-4)


def test_weighted_metrics_use_sample_weight():
    y = np.array([0, 1])
    s = np.array([0.9, 0.9])  # both predicted positive at t=0.5
    w = np.array([9.0, 1.0])
    m = compute_metrics(y, s, 0.5, weights=w)
    assert m["precision"] == pytest.approx(0.1)  # tp=1 / (tp=1 + fp=9)


def test_pick_threshold_cost_prefers_recall_when_fn_expensive():
    y = np.array([0] * 90 + [1] * 10)
    rng = np.random.default_rng(1)
    s = np.concatenate([rng.uniform(0, 0.6, 90), rng.uniform(0.4, 1.0, 10)])
    t_cheap, _ = pick_threshold_cost(y, s, c_fp=1, c_fn=1)
    t_dear, curve = pick_threshold_cost(y, s, c_fp=1, c_fn=50)
    assert t_dear <= t_cheap          # expensive FN pushes threshold down
    assert all({"threshold", "fp", "fn", "cost"} <= set(r) for r in curve)


def test_brier_and_ece_perfect_calibration():
    y = np.array([0, 1, 0, 1])
    p = np.array([0.0, 1.0, 0.0, 1.0])
    assert brier_score(y, p) == 0.0
    assert expected_calibration_error(y, p) == pytest.approx(0.0)
