"""Dynamic Threat Graph builder engine for Sentinel Fusion AI."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

from .models import (
    AIVerdict,
    EvidenceItem,
    GraphEdge,
    GraphNode,
    ThreatGraphResponse,
)
from .sequencer import AnimationSequencer


class ThreatGraphBuilder:
    """Generates visual entity relationship attack graph from event & scoring result."""

    def build_graph(
        self,
        event: Mapping[str, Any],
        score_result: Mapping[str, Any] | None = None,
        explanation: Mapping[str, Any] | None = None,
        incident_id: str | None = None,
    ) -> ThreatGraphResponse:
        domain = str(event.get("event_domain", "financial"))
        event_id = str(event.get("event_id", f"ev-{uuid.uuid4().hex[:8]}"))
        inc_id = incident_id or f"inc-{event_id}"

        event_time_raw = event.get("event_time")
        if isinstance(event_time_raw, datetime):
            ev_time = event_time_raw
        elif isinstance(event_time_raw, str):
            try:
                ev_time = datetime.fromisoformat(event_time_raw)
            except ValueError:
                ev_time = datetime.now(timezone.utc)
        else:
            ev_time = datetime.now(timezone.utc)

        # Extract risk score & level
        risk_score = float(score_result.get("risk_score", 0.5) if score_result else 0.5)
        risk_level = str(score_result.get("risk_level", "medium") if score_result else "medium")
        primary_model = score_result.get("model") if score_result else None

        nodes: list[GraphNode] = []
        edges: list[GraphEdge] = []
        evidence: list[EvidenceItem] = []

        # Parse feature attributions if available
        top_features = []
        if explanation and "top_features" in explanation:
            top_features = explanation["top_features"]

        # Delegate to domain builder
        if domain == "financial":
            self._build_financial(event, ev_time, risk_score, risk_level, top_features, nodes, edges, evidence)
        elif domain == "cyber":
            self._build_cyber(event, ev_time, risk_score, risk_level, top_features, nodes, edges, evidence)
        elif domain == "behaviour":
            self._build_behaviour(event, ev_time, risk_score, risk_level, top_features, nodes, edges, evidence)
        elif domain == "quantum":
            self._build_quantum(event, ev_time, risk_score, risk_level, top_features, nodes, edges, evidence)
        else:
            self._build_generic(event, ev_time, risk_score, risk_level, top_features, nodes, edges, evidence)

        # Sequence timeline & animation steps
        title = self._generate_title(domain, event, risk_level)
        timeline, animation_steps = AnimationSequencer.build_sequencing(nodes, edges, title, risk_level)

        # Formulate final AI verdict
        reasons = explanation.get("reasons", []) if explanation else []
        verdict = AIVerdict(
            summary=self._generate_verdict_summary(domain, risk_level, risk_score, reasons),
            confidence=round(min(1.0, risk_score * 1.05), 2),
            primary_model=str(primary_model) if primary_model else None,
            recommended_actions=self._generate_recommended_actions(domain, risk_level),
        )

        return ThreatGraphResponse(
            incident_id=inc_id,
            domain=domain,
            title=title,
            created_at=ev_time,
            risk_score=risk_score,
            risk_level=risk_level, # type: ignore
            verdict=verdict,
            nodes=nodes,
            edges=edges,
            evidence=evidence,
            timeline=timeline,
            animation_steps=animation_steps,
        )

    def _build_financial(
        self,
        ev: Mapping[str, Any],
        ev_time: datetime,
        risk_score: float,
        risk_level: str,
        top_features: list[dict[str, Any]],
        nodes: list[GraphNode],
        edges: list[GraphEdge],
        evidence: list[EvidenceItem],
    ) -> None:
        user_id = str(ev.get("user_id") or "usr_unknown")
        dev_id = str(ev.get("device_id") or "dev_unknown")
        counterparty_id = ev.get("counterparty_id")
        amount = ev.get("amount")
        country = ev.get("country") or "US"
        is_foreign = bool(ev.get("is_foreign_request", 0))
        dev_is_new = bool(ev.get("device_is_new", 0))
        new_ben = bool(ev.get("counterparty_is_new", 0))
        name_mismatch = bool(ev.get("name_mismatch", 0))

        # Node 1: Customer
        user_node = GraphNode(
            id=user_id,
            type="customer",
            label=f"Customer ({user_id})",
            node_group="actor",
            risk_score=0.2,
            is_critical=False,
            attributes={"user_id": user_id, "customer_age": ev.get("customer_age")},
        )
        nodes.append(user_node)

        # Node 2: Device
        dev_node = GraphNode(
            id=dev_id,
            type="device",
            label=f"Device ({dev_id})",
            node_group="endpoint",
            risk_score=0.85 if dev_is_new else 0.3,
            is_critical=dev_is_new and risk_score > 0.7,
            is_highlighted=dev_is_new,
            attributes={"device_id": dev_id, "device_os": ev.get("device_os"), "device_is_new": int(dev_is_new)},
        )
        nodes.append(dev_node)

        # Edge: Customer -> Device
        edges.append(
            GraphEdge(
                id=f"e_usr_dev_{dev_id}",
                source_id=user_id,
                target_id=dev_id,
                relation_type="ACCESSED_FROM",
                label="Accessed from device",
                reason="Unrecognized device signature" if dev_is_new else "Standard user device pairing",
                severity="high" if dev_is_new else "low",
                weight=0.8 if dev_is_new else 0.3,
                is_suspicious=dev_is_new,
                is_highlighted=dev_is_new,
                timestamp=ev_time,
            )
        )

        # Node 3: IP / Location if foreign or present
        if is_foreign or country:
            loc_id = f"loc_{country.lower()}"
            loc_node = GraphNode(
                id=loc_id,
                type="location",
                label=f"Location ({country})",
                node_group="network",
                risk_score=0.80 if is_foreign else 0.2,
                is_critical=is_foreign,
                is_highlighted=is_foreign,
                attributes={"country": country, "is_foreign": int(is_foreign)},
            )
            nodes.append(loc_node)

            edges.append(
                GraphEdge(
                    id=f"e_dev_loc_{loc_id}",
                    source_id=dev_id,
                    target_id=loc_id,
                    relation_type="CONNECTED_FROM",
                    label="Originated from location",
                    reason=f"Request country {country} differs from primary user region" if is_foreign else "Standard location",
                    severity="high" if is_foreign else "low",
                    weight=0.85 if is_foreign else 0.2,
                    is_suspicious=is_foreign,
                    is_highlighted=is_foreign,
                    timestamp=ev_time,
                )
            )

        # Node 4: Beneficiary / Counterparty if present
        if counterparty_id:
            cp_str = str(counterparty_id)
            ben_id = f"ben_{cp_str}"
            ben_node = GraphNode(
                id=ben_id,
                type="beneficiary",
                label=f"Beneficiary ({cp_str})",
                node_group="counterparty",
                risk_score=0.90 if (new_ben or name_mismatch) else 0.3,
                is_critical=new_ben or name_mismatch,
                is_highlighted=new_ben or name_mismatch,
                attributes={
                    "counterparty_id": cp_str,
                    "counterparty_is_new": int(new_ben),
                    "name_mismatch": int(name_mismatch),
                },
            )
            nodes.append(ben_node)

            edges.append(
                GraphEdge(
                    id=f"e_usr_ben_{ben_id}",
                    source_id=user_id,
                    target_id=ben_id,
                    relation_type="REGISTERED_BENEFICIARY",
                    label="Created beneficiary",
                    reason="Newly added beneficiary before transfer" if new_ben else "Existing beneficiary",
                    severity="high" if new_ben else "low",
                    weight=0.85 if new_ben else 0.3,
                    is_suspicious=new_ben,
                    is_highlighted=new_ben,
                    timestamp=ev_time,
                )
            )

        # Node 5: Transaction if amount present
        if amount is not None:
            txn_id = f"txn_{ev.get('event_id', '1')}"
            txn_node = GraphNode(
                id=txn_id,
                type="transaction",
                label=f"Transaction (${float(amount):,.2f})",
                node_group="event",
                risk_score=risk_score,
                is_critical=risk_score > 0.7,
                is_highlighted=risk_score > 0.7,
                attributes={"amount": amount, "currency": ev.get("currency", "USD")},
            )
            nodes.append(txn_node)

            edges.append(
                GraphEdge(
                    id=f"e_usr_txn_{txn_id}",
                    source_id=user_id,
                    target_id=txn_id,
                    relation_type="INITIATED_TRANSACTION",
                    label="Initiated transaction",
                    reason=f"High risk amount (${amount})" if risk_score > 0.7 else "Standard transfer",
                    severity="critical" if risk_score > 0.8 else "low",
                    weight=risk_score,
                    is_suspicious=risk_score > 0.7,
                    is_highlighted=risk_score > 0.7,
                    timestamp=ev_time,
                )
            )

            if counterparty_id:
                ben_id = f"ben_{counterparty_id}"
                edges.append(
                    GraphEdge(
                        id=f"e_txn_ben_{txn_id}",
                        source_id=txn_id,
                        target_id=ben_id,
                        relation_type="TRANSFERRED_FUNDS",
                        label="Transferred funds",
                        reason="Wire transfer payout target",
                        severity="critical" if risk_score > 0.8 else "low",
                        weight=risk_score,
                        is_suspicious=risk_score > 0.7,
                        is_highlighted=risk_score > 0.7,
                        timestamp=ev_time,
                    )
                )

        # Evidence mapping from top SHAP features
        for tf in top_features:
            feat_name = tf.get("feature", "")
            shap_val = tf.get("shap", 0.0)
            feat_val = tf.get("value")
            target_id = txn_id if amount is not None else dev_id
            evidence.append(
                EvidenceItem(
                    target_type="node",
                    target_id=target_id,
                    feature=feat_name,
                    feature_value=feat_val,
                    shap_attribution=shap_val,
                    description=f"Model attribution for feature '{feat_name}': SHAP={shap_val:+.3f}",
                )
            )

    def _build_cyber(
        self,
        ev: Mapping[str, Any],
        ev_time: datetime,
        risk_score: float,
        risk_level: str,
        top_features: list[dict[str, Any]],
        nodes: list[GraphNode],
        edges: list[GraphEdge],
        evidence: list[EvidenceItem],
    ) -> None:
        user_id = str(ev.get("user_id") or "attacker_external")
        dev_id = str(ev.get("device_id") or "srv_target_01")
        bytes_in = ev.get("bytes_in", 0)
        bytes_out = ev.get("bytes_out", 0)
        protocol = ev.get("protocol") or "TCP"
        src_port = ev.get("src_port") or 443
        dst_port = ev.get("dst_port") or 80

        # Node 1: Threat Actor / Source IP
        actor_node = GraphNode(
            id=user_id,
            type="threat_actor",
            label=f"Threat Source ({user_id})",
            node_group="actor",
            risk_score=risk_score,
            is_critical=risk_score > 0.7,
            is_highlighted=True,
            attributes={"src_port": src_port},
        )
        nodes.append(actor_node)

        # Node 2: Target Server
        srv_node = GraphNode(
            id=dev_id,
            type="server",
            label=f"Target Server ({dev_id})",
            node_group="endpoint",
            risk_score=0.4,
            is_critical=False,
            attributes={"dst_port": dst_port, "protocol": protocol},
        )
        nodes.append(srv_node)

        # Edge: Threat Source -> Target Server
        edges.append(
            GraphEdge(
                id=f"e_cyber_{user_id}_{dev_id}",
                source_id=user_id,
                target_id=dev_id,
                relation_type="ATTACKED_SERVER",
                label=f"Network Intrusion ({protocol}:{dst_port})",
                reason=f"Anomalous traffic flow (In: {bytes_in}B, Out: {bytes_out}B)",
                severity="critical" if risk_score > 0.8 else "medium",
                weight=risk_score,
                is_suspicious=risk_score > 0.6,
                is_highlighted=risk_score > 0.6,
                timestamp=ev_time,
            )
        )

        for tf in top_features:
            evidence.append(
                EvidenceItem(
                    target_type="edge",
                    target_id=edges[0].id,
                    feature=tf.get("feature", ""),
                    feature_value=tf.get("value"),
                    shap_attribution=tf.get("shap", 0.0),
                    description=f"Cyber anomaly factor: {tf.get('feature')}",
                )
            )

    def _build_behaviour(
        self,
        ev: Mapping[str, Any],
        ev_time: datetime,
        risk_score: float,
        risk_level: str,
        top_features: list[dict[str, Any]],
        nodes: list[GraphNode],
        edges: list[GraphEdge],
        evidence: list[EvidenceItem],
    ) -> None:
        user_id = str(ev.get("user_id") or "usr_behaviour")
        dev_id = str(ev.get("device_id") or "dev_behaviour")
        sess_len = ev.get("session_length_s", 0)

        usr_node = GraphNode(
            id=user_id,
            type="customer",
            label=f"User ({user_id})",
            node_group="actor",
            risk_score=risk_score,
            is_critical=risk_score > 0.7,
            attributes={"user_id": user_id},
        )
        nodes.append(usr_node)

        sess_id = f"sess_{ev.get('event_id', '1')}"
        sess_node = GraphNode(
            id=sess_id,
            type="session",
            label=f"Login Session ({sess_len}s)",
            node_group="event",
            risk_score=risk_score,
            is_critical=risk_score > 0.7,
            is_highlighted=True,
            attributes={"session_length_s": sess_len},
        )
        nodes.append(sess_node)

        edges.append(
            GraphEdge(
                id=f"e_beh_{user_id}_{sess_id}",
                source_id=user_id,
                target_id=sess_id,
                relation_type="ESTABLISHED_SESSION",
                label="Established Session",
                reason="Behavioral profile deviation during active session",
                severity="high" if risk_score > 0.7 else "low",
                weight=risk_score,
                is_suspicious=risk_score > 0.6,
                is_highlighted=risk_score > 0.6,
                timestamp=ev_time,
            )
        )

    def _build_quantum(
        self,
        ev: Mapping[str, Any],
        ev_time: datetime,
        risk_score: float,
        risk_level: str,
        top_features: list[dict[str, Any]],
        nodes: list[GraphNode],
        edges: list[GraphEdge],
        evidence: list[EvidenceItem],
    ) -> None:
        key_ex = ev.get("q_key_exchange") or "RSA-2048"
        data_cls = ev.get("q_data_class") or "CONFIDENTIAL"

        key_id = f"key_{key_ex.lower().replace('-', '_')}"
        key_node = GraphNode(
            id=key_id,
            type="key_pair",
            label=f"Cryptographic Key ({key_ex})",
            node_group="crypto",
            risk_score=risk_score,
            is_critical=risk_score > 0.7,
            is_highlighted=True,
            attributes={"key_exchange": key_ex, "data_class": data_cls},
        )
        nodes.append(key_node)

        srv_id = "srv_quantum_gateway"
        srv_node = GraphNode(
            id=srv_id,
            type="server",
            label="Crypto Gateway Server",
            node_group="endpoint",
            risk_score=0.3,
            attributes={},
        )
        nodes.append(srv_node)

        edges.append(
            GraphEdge(
                id=f"e_q_{key_id}_{srv_id}",
                source_id=key_id,
                target_id=srv_id,
                relation_type="EXPOSED_CRYPTO_SUITE",
                label="Vulnerable Key Exchange",
                reason=f"Post-Quantum vulnerability detected for data class '{data_cls}'",
                severity="critical" if risk_score > 0.7 else "medium",
                weight=risk_score,
                is_suspicious=risk_score > 0.6,
                is_highlighted=risk_score > 0.6,
                timestamp=ev_time,
            )
        )

    def _build_generic(
        self,
        ev: Mapping[str, Any],
        ev_time: datetime,
        risk_score: float,
        risk_level: str,
        top_features: list[dict[str, Any]],
        nodes: list[GraphNode],
        edges: list[GraphEdge],
        evidence: list[EvidenceItem],
    ) -> None:
        u_id = str(ev.get("user_id") or "entity_a")
        d_id = str(ev.get("device_id") or "entity_b")

        n1 = GraphNode(id=u_id, type="generic", label=f"Entity ({u_id})", node_group="actor", risk_score=risk_score)
        n2 = GraphNode(id=d_id, type="generic", label=f"Target ({d_id})", node_group="endpoint", risk_score=0.3)
        nodes.extend([n1, n2])

        edges.append(
            GraphEdge(
                id=f"e_gen_{u_id}_{d_id}",
                source_id=u_id,
                target_id=d_id,
                relation_type="INTERACTED_WITH",
                label="Event Interaction",
                reason="Generic security event interaction",
                severity="medium" if risk_score > 0.6 else "low",
                weight=risk_score,
                is_suspicious=risk_score > 0.6,
                timestamp=ev_time,
            )
        )

    def _generate_title(self, domain: str, ev: Mapping[str, Any], risk_level: str) -> str:
        if domain == "financial":
            if ev.get("counterparty_is_new") or ev.get("device_is_new"):
                return "Account Takeover & High-Risk Beneficiary Transfer"
            return "Anomalous Payment Transaction"
        if domain == "cyber":
            return "Network Intrusion & Compromised Server Flow"
        if domain == "behaviour":
            return "Anomalous Session Behavioral Pattern"
        if domain == "quantum":
            return "Harvest-Now-Decrypt-Later Cryptographic Risk"
        return f"{domain.capitalize()} Security Incident"

    def _generate_verdict_summary(
        self, domain: str, risk_level: str, risk_score: float, reasons: list[str]
    ) -> str:
        if reasons:
            return " ".join(reasons)
        return (
            f"AI models identified {risk_level.upper()} severity risk (score: {risk_score:.2f}) "
            f"in {domain} analysis stream."
        )

    def _generate_recommended_actions(self, domain: str, risk_level: str) -> list[str]:
        if risk_level in ("high", "critical"):
            if domain == "financial":
                return [
                    "Freeze Customer Account",
                    "Block Pending Beneficiary Transfer",
                    "Require Step-Up Multi-Factor Auth",
                ]
            if domain == "cyber":
                return [
                    "Isolate Target Host",
                    "Block Attacker IP at Firewall",
                    "Revoke Compounding Credentials",
                ]
            if domain == "quantum":
                return [
                    "Migrate Certificate to Kyber/Dilithium PQC Suite",
                    "Enforce Hybrid Post-Quantum TLS",
                ]
            return ["Initiate Incident Response Playbook", "Quarantine Compromised Entities"]
        return ["Monitor Entity Activity", "Log Audit Event"]
