"""Model training — CPU baselines, fixed seeds, no hyperparameter search.

Each trainer returns a *bundle* dict:
    model      fitted estimator (sklearn API)
    features   ordered feature list the model expects
    encoder    CategoryEncoder mapping (JSON-safe dict)
    medians    train medians (IsolationForest only — NaN imputation)
    threshold  decision threshold chosen on validation (max F1)
Bundles are joblib-serialized by run_pipeline; GBMs also export native format.

Training is unweighted by design: sampling_weight encodes the unify-stage
benign caps and is used for population-weighted *evaluation*, while class
imbalance is handled by scale_pos_weight — mixing both would double-count.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import IFOREST_PARAMS, LGBM_PARAMS, XGB_PARAMS


def _spw(y: np.ndarray) -> float:
    pos = max(int((y == 1).sum()), 1)
    return float((y == 0).sum() / pos)


def train_xgb(X_tr: pd.DataFrame, y_tr: np.ndarray,
              X_val: pd.DataFrame, y_val: np.ndarray,
              params: dict | None = None):
    from xgboost import XGBClassifier
    model = XGBClassifier(**{**XGB_PARAMS, **(params or {})},
                          scale_pos_weight=_spw(y_tr))
    model.fit(X_tr, y_tr, eval_set=[(X_val, y_val)], verbose=False)
    return model


def train_lgbm(X_tr: pd.DataFrame, y_tr: np.ndarray,
               X_val: pd.DataFrame, y_val: np.ndarray,
               params: dict | None = None):
    import lightgbm as lgb
    model = lgb.LGBMClassifier(**{**LGBM_PARAMS, **(params or {})},
                               scale_pos_weight=_spw(y_tr))
    model.fit(X_tr, y_tr, eval_set=[(X_val, y_val)], eval_metric="auc",
              callbacks=[lgb.early_stopping(30, verbose=False)])
    return model


def train_iforest(X_tr_imputed: pd.DataFrame, params: dict | None = None):
    """Unsupervised: fit on ALL behaviour train rows (labeled rba + unlabeled
    cert_insider). Labels never touch training — only threshold selection."""
    from sklearn.ensemble import IsolationForest
    model = IsolationForest(**{**IFOREST_PARAMS, **(params or {})})
    model.fit(X_tr_imputed)
    return model


def score(model, X: pd.DataFrame) -> np.ndarray:
    """Uniform 'higher = riskier' score for any model in the registry."""
    if hasattr(model, "predict_proba"):
        return model.predict_proba(X)[:, 1]
    return -model.decision_function(X)  # IsolationForest anomaly score
