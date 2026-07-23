"""Shared fixtures. Memory discipline: fast tier only ever touches the
committed ~44K-row mini fixture; the full 2M-row parquet loads once per
session and only for tests marked slow/quality/perf (skipped when absent)."""
from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from ml.config import ENGINEERED_PARQUET, MODELS

FIXTURES = Path(__file__).resolve().parent / "fixtures"
MINI_EVENTS = FIXTURES / "mini_events.parquet"
MINI_QPART = FIXTURES / "mini_quantum_part.parquet"
MODEL_KEYS = ["fraud_payment", "fraud_application", "cyber", "behaviour", "quantum"]


@pytest.fixture(scope="session")
def fixture_frame() -> pd.DataFrame:
    from ml.data import load_engineered
    return load_engineered(parquet_path=MINI_EVENTS, quantum_path=MINI_QPART)


@pytest.fixture(scope="session")
def fixture_split(fixture_frame):
    from ml.data import temporal_split
    return temporal_split(fixture_frame)


@pytest.fixture(scope="session")
def mini_artifacts(fixture_frame, tmp_path_factory) -> Path:
    """Real pipeline, tiny models, isolated dirs. ~15s once per session."""
    root = tmp_path_factory.mktemp("mini")
    models, reports = root / "models", root / "reports"
    from ml.run_pipeline import run
    run(fixture_frame.copy(), models_dir=models, reports_dir=reports,
        fast=True, skip_shap=True)
    return models


@pytest.fixture(scope="session")
def scorer(mini_artifacts):
    from ml.predict import SentinelScorer
    return SentinelScorer(mini_artifacts)


@pytest.fixture(scope="session")
def full_frame() -> pd.DataFrame:
    if not ENGINEERED_PARQUET.exists():
        pytest.skip("full engineered parquet not present on this machine")
    from ml.data import load_engineered
    return load_engineered()


@pytest.fixture(scope="session")
def real_artifacts() -> Path:
    if not (MODELS / "fraud_payment_bundle.joblib").exists():
        pytest.skip("trained models/ not present on this machine")
    return MODELS
