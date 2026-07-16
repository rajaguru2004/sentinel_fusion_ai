"""Evaluation: threshold selection, full metric suite, inference latency.

Metrics reported twice where sampling weights exist:
    unweighted — corpus as trained on
    weighted   — sampling_weight applied, recovers population rates distorted
                 by the unify-stage benign caps
"""
from __future__ import annotations

import time

import numpy as np
import pandas as pd
from sklearn.metrics import (accuracy_score, confusion_matrix, f1_score,
                             precision_recall_curve, precision_score,
                             recall_score, roc_auc_score)

from .config import LATENCY_BATCH_SIZE, LATENCY_SINGLE_ROWS


def pick_threshold(y_val: np.ndarray, s_val: np.ndarray) -> float:
    """Threshold maximizing F1 on validation."""
    prec, rec, thr = precision_recall_curve(y_val, s_val)
    f1 = 2 * prec * rec / np.clip(prec + rec, 1e-12, None)
    return float(thr[int(np.argmax(f1[:-1]))])


def compute_metrics(y: np.ndarray, s: np.ndarray, threshold: float,
                    weights: np.ndarray | None = None) -> dict:
    pred = (s >= threshold).astype("int8")
    kw = {"sample_weight": weights} if weights is not None else {}
    cm = confusion_matrix(y, pred, labels=[0, 1], **kw)
    return {
        "accuracy": round(float(accuracy_score(y, pred, **kw)), 4),
        "precision": round(float(precision_score(y, pred, zero_division=0, **kw)), 4),
        "recall": round(float(recall_score(y, pred, zero_division=0, **kw)), 4),
        "f1": round(float(f1_score(y, pred, zero_division=0, **kw)), 4),
        "roc_auc": round(float(roc_auc_score(y, s, **kw)), 4),
        "confusion_matrix": {"tn": float(cm[0, 0]), "fp": float(cm[0, 1]),
                             "fn": float(cm[1, 0]), "tp": float(cm[1, 1])},
    }


def latency_benchmark(model, X: pd.DataFrame) -> dict:
    """Single-row (realistic online path incl. pandas slice) + batch throughput."""
    predict = (model.predict_proba if hasattr(model, "predict_proba")
               else model.decision_function)
    n = min(LATENCY_SINGLE_ROWS, len(X))
    predict(X.iloc[[0]])  # warm-up
    t_single = []
    for i in range(n):
        t0 = time.perf_counter()
        predict(X.iloc[[i]])
        t_single.append((time.perf_counter() - t0) * 1e3)
    t_single = np.array(t_single)

    batch = X.iloc[:LATENCY_BATCH_SIZE]
    t0 = time.perf_counter()
    predict(batch)
    dt = time.perf_counter() - t0
    return {
        "single_row_ms": {"mean": round(float(t_single.mean()), 3),
                          "p50": round(float(np.percentile(t_single, 50)), 3),
                          "p95": round(float(np.percentile(t_single, 95)), 3)},
        "batch_rows": int(len(batch)),
        "batch_rows_per_sec": int(len(batch) / dt),
    }
