"""Unit tests for Dynamic Threat Graph builder and sequencing."""
from datetime import datetime, timezone

import pytest

from service.graph.builder import ThreatGraphBuilder
from service.graph.models import ThreatGraphResponse
from service.graph.sequencer import AnimationSequencer


def test_financial_threat_graph_building():
    event = {
        "event_id": "ev_fin_1001",
        "event_domain": "financial",
        "event_time": datetime.now(timezone.utc),
        "user_id": "usr_9981",
        "device_id": "dev_4412",
        "amount": 25000.0,
        "currency": "USD",
        "counterparty_id": "ben_7712",
        "counterparty_is_new": 1,
        "device_is_new": 1,
        "is_foreign_request": 1,
        "country": "DE",
    }
    score_result = {
        "risk_score": 0.92,
        "risk_level": "critical",
        "model": "fraud_payment",
    }
    explanation = {
        "reasons": ["New beneficiary added before transfer", "Foreign IP request"],
        "top_features": [
            {"feature": "counterparty_is_new", "shap": 0.35, "value": 1.0},
            {"feature": "is_foreign_request", "shap": 0.25, "value": 1.0},
        ],
    }

    builder = ThreatGraphBuilder()
    graph = builder.build_graph(event=event, score_result=score_result, explanation=explanation)

    assert isinstance(graph, ThreatGraphResponse)
    assert graph.domain == "financial"
    assert graph.risk_score == 0.92
    assert graph.risk_level == "critical"
    assert len(graph.nodes) >= 4  # user, device, location, beneficiary, transaction
    assert len(graph.edges) >= 4
    assert len(graph.animation_steps) >= 3
    assert len(graph.evidence) == 2
    assert graph.verdict.confidence > 0.9


def test_cyber_threat_graph_building():
    event = {
        "event_id": "ev_cyb_2002",
        "event_domain": "cyber",
        "event_time": datetime.now(timezone.utc),
        "user_id": "attacker_185.220.101.5",
        "device_id": "srv_db_master",
        "bytes_in": 1048576,
        "bytes_out": 2048,
        "protocol": "TCP",
        "dst_port": 3306,
    }
    score_result = {"risk_score": 0.88, "risk_level": "high", "model": "cyber"}

    builder = ThreatGraphBuilder()
    graph = builder.build_graph(event=event, score_result=score_result)

    assert graph.domain == "cyber"
    assert any(n.type == "threat_actor" for n in graph.nodes)
    assert any(n.type == "server" for n in graph.nodes)
    assert len(graph.edges) == 1
    assert graph.edges[0].relation_type == "ATTACKED_SERVER"


def test_quantum_threat_graph_building():
    event = {
        "event_id": "ev_q_3003",
        "event_domain": "quantum",
        "event_time": datetime.now(timezone.utc),
        "q_key_exchange": "RSA-2048",
        "q_data_class": "TOP_SECRET",
    }
    score_result = {"risk_score": 0.95, "risk_level": "critical", "model": "quantum"}

    builder = ThreatGraphBuilder()
    graph = builder.build_graph(event=event, score_result=score_result)

    assert graph.domain == "quantum"
    assert any(n.type == "key_pair" for n in graph.nodes)
    assert any(e.relation_type == "EXPOSED_CRYPTO_SUITE" for e in graph.edges)
