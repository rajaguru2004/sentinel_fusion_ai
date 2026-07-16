"""Sentinel Fusion AI — terminal SOC demonstration.

    python sentinel_demo.py [--scenario attack|benign] [--fast]

Real inference only: trained bundles from models/, real Risk Fusion Engine,
SHAP computed live per event. Event data is simulated (built from real labeled
test-split rows with story identities); predictions are never faked.
"""
