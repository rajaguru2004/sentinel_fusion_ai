"""Sentinel Fusion AI serving layer — FastAPI + online feature store."""
from __future__ import annotations

from .app import create_app

__all__ = ["create_app"]
