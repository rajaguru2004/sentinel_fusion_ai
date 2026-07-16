"""Sentinel Fusion AI — ML training pipeline (Phase 2).

Modules:
    config       — paths, seed, feature sets, model params
    data         — load engineered corpus, per-source temporal split
    features     — per-model feature matrices + categorical encoding
    train        — model training (XGBoost / LightGBM / IsolationForest)
    evaluate     — metrics, confusion matrix, inference latency
    explain      — SHAP explainability reports
    fusion       — Risk Fusion Engine (calibrated noisy-OR)
    run_pipeline — end-to-end orchestration
"""
