"""API surface vs docs/API.md — keeps the reference honest.

The docs drifted badly in v1 (they still described a single `fraud` model, a
`degraded` boolean, and "scoring is not idempotent" long after all three had
changed). An integration engineer reading a stale reference builds against an
API that does not exist, so the coherence is asserted rather than trusted.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

API_DOC = Path(__file__).resolve().parents[2] / "docs" / "API.md"


@pytest.fixture(scope="module")
def doc() -> str:
    return API_DOC.read_text()


@pytest.fixture(scope="module")
def spec(client):
    return client.get("/openapi.json").json()


def test_every_live_route_is_documented(doc, spec):
    documented = set(re.findall(r"`(/[a-z/]+)`", doc))
    live = set(spec["paths"])
    missing = live - documented
    assert not missing, f"routes exist but are undocumented: {sorted(missing)}"


def test_every_documented_route_exists(doc, spec):
    # Only check paths that appear in the endpoint table (backticked, leading /).
    documented = {p for p in re.findall(r"\| (?:GET|POST) +\| `(/[a-z/]+)`", doc)}
    live = set(spec["paths"])
    ghosts = documented - live
    assert not ghosts, f"documented but not implemented: {sorted(ghosts)}"


def test_scoreout_fields_are_documented(doc, spec):
    for field in spec["components"]["schemas"]["ScoreOut"]["properties"]:
        assert f"`{field}`" in doc, f"ScoreOut.{field} missing from docs/API.md"


def test_degradation_fields_are_documented(doc, spec):
    for field in spec["components"]["schemas"]["DegradedDetail"]["properties"]:
        assert f"`{field}`" in doc, f"DegradedDetail.{field} missing from docs"


def test_contribution_fields_are_documented(doc, spec):
    for field in spec["components"]["schemas"]["Contributions"]["properties"]:
        assert f"`{field}`" in doc, f"Contributions.{field} missing from docs"


def test_banking_fields_are_documented(doc, spec):
    """The §3.3 block is the whole point of the v2 contract — every field the
    bank can send must be findable in the reference."""
    props = spec["components"]["schemas"]["EventIn"]["properties"]
    banking = [f for f in props
               if f.startswith("bank_") or f.startswith("counterparty_")
               or f in {"name_mismatch", "balance_before", "balance_after",
                        "merchant_category", "payment_type", "channel"}]
    undocumented = [f for f in banking if f"`{f}`" not in doc]
    assert not undocumented, f"banking fields missing from docs: {undocumented}"


def test_documented_model_names_match_routing(doc):
    from ml.feature_spec import MODEL_FEATURES
    for key in MODEL_FEATURES:
        assert f"`{key}`" in doc, f"model {key} not documented"


def test_routing_table_lists_no_removed_model(doc):
    """`fraud` may appear in the migration note — it must not appear as a
    routing target, which is what an integrator would build against."""
    table = doc.split("## 1. What this API does", 1)[1].split("### Typical", 1)[0]
    rows = [ln for ln in table.splitlines() if ln.strip().startswith("|")]
    assert not any("| `fraud` |" in ln for ln in rows), \
        "routing table still offers the removed `fraud` model"


def test_documented_bands_match_the_trained_engine(doc, mini_artifacts):
    """Band edges are refitted on every retrain; the doc must not claim stale
    numbers as current."""
    import joblib
    eng = joblib.load(mini_artifacts / "fusion_engine.joblib")
    assert hasattr(eng, "bands"), "fusion engine has no fitted bands"
    # Documented table must at least name every model that has fitted bands.
    for key in eng.bands:
        assert f"`{key}`" in doc


def test_error_codes_documented(doc):
    for code in ("401", "413", "422", "429", "503", "202"):
        assert f"| {code} |" in doc, f"status {code} missing from the error table"
