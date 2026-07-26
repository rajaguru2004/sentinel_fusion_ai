"""MITRE ATT&CK knowledge base for the AI Attack Replay Engine.

Defines all 12 MITRE ATT&CK tactics as stages with:
- kill_chain_phase: Cyber Kill Chain mapping
- evidence_signals: event/feature fields that indicate this stage
- signal_weights: per-signal weight for classification voting
- transitions: ordered (next_stage_id, base_probability) arcs
- predecessor_stages: stages that precede this one (for completed-stage walk)
- sentinel_response: defensive actions Sentinel takes at this stage
- without_sentinel_next: what attacker does next without Sentinel
- description: analyst-facing description

Extend: add new stages here only. Engine code never changes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass(frozen=True)
class ATTCKStage:
    id: str
    name: str
    description: str
    kill_chain_phase: str
    mitre_tactic_id: str
    evidence_signals: tuple[str, ...]
    signal_weights: dict[str, float]
    transitions: tuple[tuple[str, float], ...]        # (next_stage_id, base_prob)
    predecessor_stages: tuple[str, ...]               # most-likely predecessors, ordered
    sentinel_response: tuple[str, ...]                # with-Sentinel defensive actions
    without_sentinel_next: tuple[str, ...]            # attacker next steps without Sentinel
    attack_maturity: str                              # "Early"|"Mid"|"Late"|"Critical"


STAGES: dict[str, ATTCKStage] = {
    "initial_access": ATTCKStage(
        id="initial_access",
        name="Initial Access",
        description="Attacker gains entry to the network via phishing, exploit, or stolen credentials.",
        kill_chain_phase="Delivery",
        mitre_tactic_id="TA0001",
        evidence_signals=(
            "f_user_seq_no",
            "f_user_secs_since_last",
            "is_foreign_request",
            "device_is_new",
            "event_subtype",
        ),
        signal_weights={
            "f_user_seq_no": 0.70,
            "f_user_secs_since_last": 0.50,
            "is_foreign_request": 0.80,
            "device_is_new": 0.75,
            "event_subtype": 0.60,
        },
        transitions=(
            ("execution", 0.82),
            ("persistence", 0.45),
            ("defense_evasion", 0.30),
        ),
        predecessor_stages=(),
        sentinel_response=(
            "Block foreign request origin",
            "Flag new device for step-up authentication",
            "Alert SOC on initial access indicator",
        ),
        without_sentinel_next=(
            "Establish foothold via dropped payload",
            "Execute initial reconnaissance commands",
        ),
        attack_maturity="Early",
    ),

    "execution": ATTCKStage(
        id="execution",
        name="Execution",
        description="Attacker runs malicious code on target systems.",
        kill_chain_phase="Exploitation",
        mitre_tactic_id="TA0002",
        evidence_signals=(
            "f_device_past_hisev_count",
            "severity",
            "event_type",
            "duration_s",
            "bytes_in",
        ),
        signal_weights={
            "f_device_past_hisev_count": 0.90,
            "severity": 0.80,
            "event_type": 0.65,
            "duration_s": 0.50,
            "bytes_in": 0.55,
        },
        transitions=(
            ("credential_access", 0.72),
            ("discovery", 0.65),
            ("persistence", 0.55),
            ("privilege_escalation", 0.48),
            ("lateral_movement", 0.40),
        ),
        predecessor_stages=("initial_access",),
        sentinel_response=(
            "Terminate malicious process tree",
            "Quarantine executing host",
            "Preserve forensic memory dump",
        ),
        without_sentinel_next=(
            "Dump credential stores from memory",
            "Enumerate network topology and open shares",
        ),
        attack_maturity="Early",
    ),

    "persistence": ATTCKStage(
        id="persistence",
        name="Persistence",
        description="Attacker maintains access across reboots and credential resets.",
        kill_chain_phase="Installation",
        mitre_tactic_id="TA0003",
        evidence_signals=(
            "event_subtype",
            "dst_port",
            "protocol",
            "duration_s",
        ),
        signal_weights={
            "event_subtype": 0.70,
            "dst_port": 0.60,
            "protocol": 0.55,
            "duration_s": 0.65,
        },
        transitions=(
            ("privilege_escalation", 0.68),
            ("defense_evasion", 0.60),
            ("command_and_control", 0.55),
            ("lateral_movement", 0.45),
        ),
        predecessor_stages=("execution", "initial_access"),
        sentinel_response=(
            "Remove persistence mechanism",
            "Revoke scheduled task or registry run key",
            "Reset affected service accounts",
        ),
        without_sentinel_next=(
            "Escalate to SYSTEM or root privileges",
            "Cover tracks and evade AV detection",
        ),
        attack_maturity="Mid",
    ),

    "privilege_escalation": ATTCKStage(
        id="privilege_escalation",
        name="Privilege Escalation",
        description="Attacker gains higher-level permissions on the system or network.",
        kill_chain_phase="Exploitation",
        mitre_tactic_id="TA0004",
        evidence_signals=(
            "f_device_past_hisev_count",
            "severity",
            "event_subtype",
            "dst_port",
        ),
        signal_weights={
            "f_device_past_hisev_count": 0.85,
            "severity": 0.80,
            "event_subtype": 0.75,
            "dst_port": 0.55,
        },
        transitions=(
            ("defense_evasion", 0.70),
            ("lateral_movement", 0.65),
            ("collection", 0.55),
            ("command_and_control", 0.50),
        ),
        predecessor_stages=("persistence", "execution"),
        sentinel_response=(
            "Revoke elevated token and sudo session",
            "Lock privileged account",
            "Force re-authentication on critical services",
        ),
        without_sentinel_next=(
            "Disable security tooling and logging",
            "Move laterally to high-value targets",
        ),
        attack_maturity="Mid",
    ),

    "defense_evasion": ATTCKStage(
        id="defense_evasion",
        name="Defense Evasion",
        description="Attacker avoids detection by disabling logging, clearing events, or obfuscating payloads.",
        kill_chain_phase="Installation",
        mitre_tactic_id="TA0005",
        evidence_signals=(
            "event_subtype",
            "protocol",
            "bytes_out",
            "duration_s",
        ),
        signal_weights={
            "event_subtype": 0.70,
            "protocol": 0.60,
            "bytes_out": 0.55,
            "duration_s": 0.50,
        },
        transitions=(
            ("lateral_movement", 0.70),
            ("command_and_control", 0.65),
            ("credential_access", 0.60),
            ("collection", 0.55),
        ),
        predecessor_stages=("privilege_escalation", "persistence"),
        sentinel_response=(
            "Restore tampered audit log configuration",
            "Re-enable EDR real-time protection",
            "Alert SIEM on log gap anomaly",
        ),
        without_sentinel_next=(
            "Move laterally under radar",
            "Stage data for exfiltration",
        ),
        attack_maturity="Mid",
    ),

    "credential_access": ATTCKStage(
        id="credential_access",
        name="Credential Access",
        description="Attacker steals account credentials via credential dumping, keylogging, or phishing.",
        kill_chain_phase="Exploitation",
        mitre_tactic_id="TA0006",
        evidence_signals=(
            "event_subtype",
            "f_device_past_hisev_count",
            "bytes_in",
            "dst_port",
            "severity",
        ),
        signal_weights={
            "event_subtype": 0.90,
            "f_device_past_hisev_count": 0.85,
            "bytes_in": 0.65,
            "dst_port": 0.70,
            "severity": 0.75,
        },
        transitions=(
            ("lateral_movement", 0.75),
            ("discovery", 0.68),
            ("privilege_escalation", 0.60),
            ("collection", 0.50),
        ),
        predecessor_stages=("execution", "initial_access"),
        sentinel_response=(
            "Force enterprise-wide password reset",
            "Revoke all active sessions for compromised accounts",
            "Enable MFA enforcement on all services",
        ),
        without_sentinel_next=(
            "Use stolen credentials for lateral movement",
            "Access high-value data repositories",
        ),
        attack_maturity="Mid",
    ),

    "discovery": ATTCKStage(
        id="discovery",
        name="Discovery",
        description="Attacker scans and enumerates the environment: hosts, shares, services, and users.",
        kill_chain_phase="Reconnaissance",
        mitre_tactic_id="TA0007",
        evidence_signals=(
            "event_subtype",
            "bytes_in",
            "dst_port",
            "protocol",
            "duration_s",
        ),
        signal_weights={
            "event_subtype": 0.85,
            "bytes_in": 0.60,
            "dst_port": 0.65,
            "protocol": 0.55,
            "duration_s": 0.50,
        },
        transitions=(
            ("lateral_movement", 0.72),
            ("collection", 0.65),
            ("command_and_control", 0.55),
            ("exfiltration", 0.40),
        ),
        predecessor_stages=("execution", "credential_access"),
        sentinel_response=(
            "Block port-scan source at network perimeter",
            "Isolate enumerated network segment",
            "Alert on abnormal internal reconnaissance pattern",
        ),
        without_sentinel_next=(
            "Map high-value targets from discovered topology",
            "Begin data staging from identified file shares",
        ),
        attack_maturity="Mid",
    ),

    "lateral_movement": ATTCKStage(
        id="lateral_movement",
        name="Lateral Movement",
        description="Attacker pivots from initial host to other systems using stolen credentials or exploits.",
        kill_chain_phase="Lateral Movement",
        mitre_tactic_id="TA0008",
        evidence_signals=(
            "dst_port",
            "protocol",
            "bytes_in",
            "bytes_out",
            "f_device_past_hisev_count",
        ),
        signal_weights={
            "dst_port": 0.80,
            "protocol": 0.70,
            "bytes_in": 0.65,
            "bytes_out": 0.60,
            "f_device_past_hisev_count": 0.75,
        },
        transitions=(
            ("collection", 0.75),
            ("command_and_control", 0.70),
            ("privilege_escalation", 0.55),
            ("exfiltration", 0.50),
        ),
        predecessor_stages=("credential_access", "discovery", "privilege_escalation"),
        sentinel_response=(
            "Isolate pivot host from internal network",
            "Block SMB, RDP, and SSH tunnels at internal firewall",
            "Revoke lateral access credentials",
        ),
        without_sentinel_next=(
            "Reach domain controller or database server",
            "Collect and stage sensitive data",
        ),
        attack_maturity="Late",
    ),

    "collection": ATTCKStage(
        id="collection",
        name="Collection",
        description="Attacker gathers data of interest: files, emails, credentials, screenshots.",
        kill_chain_phase="Actions on Objectives",
        mitre_tactic_id="TA0009",
        evidence_signals=(
            "bytes_in",
            "bytes_out",
            "duration_s",
            "dst_port",
            "severity",
        ),
        signal_weights={
            "bytes_in": 0.70,
            "bytes_out": 0.75,
            "duration_s": 0.65,
            "dst_port": 0.55,
            "severity": 0.70,
        },
        transitions=(
            ("exfiltration", 0.85),
            ("command_and_control", 0.65),
            ("impact", 0.45),
        ),
        predecessor_stages=("lateral_movement", "discovery"),
        sentinel_response=(
            "Block access to identified data staging directory",
            "Revoke read permissions on sensitive shares",
            "Capture forensic copy of staged data",
        ),
        without_sentinel_next=(
            "Compress and encrypt staged data",
            "Exfiltrate over encrypted channel",
        ),
        attack_maturity="Late",
    ),

    "command_and_control": ATTCKStage(
        id="command_and_control",
        name="Command & Control",
        description="Attacker communicates with compromised systems via covert C2 channel.",
        kill_chain_phase="Command & Control",
        mitre_tactic_id="TA0011",
        evidence_signals=(
            "protocol",
            "dst_port",
            "bytes_out",
            "duration_s",
            "bytes_in",
        ),
        signal_weights={
            "protocol": 0.75,
            "dst_port": 0.70,
            "bytes_out": 0.65,
            "duration_s": 0.80,
            "bytes_in": 0.60,
        },
        transitions=(
            ("exfiltration", 0.78),
            ("collection", 0.65),
            ("impact", 0.55),
            ("lateral_movement", 0.45),
        ),
        predecessor_stages=("persistence", "lateral_movement"),
        sentinel_response=(
            "Block C2 domain and IP at DNS and firewall",
            "Sinkhole beacon traffic",
            "Terminate beaconing process on host",
        ),
        without_sentinel_next=(
            "Issue exfiltration commands over C2 tunnel",
            "Deploy ransomware payload via C2 channel",
        ),
        attack_maturity="Late",
    ),

    "exfiltration": ATTCKStage(
        id="exfiltration",
        name="Exfiltration",
        description="Attacker transfers stolen data to attacker-controlled infrastructure.",
        kill_chain_phase="Actions on Objectives",
        mitre_tactic_id="TA0010",
        evidence_signals=(
            "bytes_out",
            "protocol",
            "dst_port",
            "duration_s",
            "severity",
        ),
        signal_weights={
            "bytes_out": 0.90,
            "protocol": 0.70,
            "dst_port": 0.65,
            "duration_s": 0.75,
            "severity": 0.80,
        },
        transitions=(
            ("impact", 0.70),
            ("command_and_control", 0.50),
        ),
        predecessor_stages=("collection", "command_and_control"),
        sentinel_response=(
            "Block all outbound traffic from host",
            "Notify Data Protection Officer",
            "Begin breach containment runbook",
        ),
        without_sentinel_next=(
            "Destroy evidence and encrypt victim data",
            "Deploy ransomware for maximum business impact",
        ),
        attack_maturity="Critical",
    ),

    "impact": ATTCKStage(
        id="impact",
        name="Impact",
        description="Attacker disrupts business operations via ransomware, data destruction, or service denial.",
        kill_chain_phase="Actions on Objectives",
        mitre_tactic_id="TA0040",
        evidence_signals=(
            "severity",
            "bytes_out",
            "duration_s",
            "event_subtype",
            "f_device_past_hisev_count",
        ),
        signal_weights={
            "severity": 0.90,
            "bytes_out": 0.70,
            "duration_s": 0.65,
            "event_subtype": 0.80,
            "f_device_past_hisev_count": 0.85,
        },
        transitions=(),  # terminal stage
        predecessor_stages=("exfiltration", "command_and_control"),
        sentinel_response=(
            "Initiate full incident response playbook",
            "Isolate all affected network segments",
            "Engage cyber insurance and legal counsel",
        ),
        without_sentinel_next=(
            "Business operations disrupted",
            "Ransom demand issued",
            "Regulatory breach notification required",
        ),
        attack_maturity="Critical",
    ),
}

# Canonical stage order (early to late)
STAGE_ORDER: list[str] = [
    "initial_access",
    "execution",
    "persistence",
    "privilege_escalation",
    "defense_evasion",
    "credential_access",
    "discovery",
    "lateral_movement",
    "collection",
    "command_and_control",
    "exfiltration",
    "impact",
]

# Raw event-field signals (no SHAP required)
RAW_FIELD_SIGNALS: list[dict[str, Any]] = [
    {
        "field": "bytes_out",
        "condition": lambda v: v is not None and v > 50_000,
        "stage_id": "exfiltration",
        "signal_strength": 0.85,
        "description": lambda v: f"High outbound bytes ({int(v):,}) — potential data exfiltration",
    },
    {
        "field": "bytes_out",
        "condition": lambda v: v is not None and 10_000 < v <= 50_000,
        "stage_id": "collection",
        "signal_strength": 0.65,
        "description": lambda v: f"Elevated outbound bytes ({int(v):,}) — data staging activity",
    },
    {
        "field": "bytes_in",
        "condition": lambda v: v is not None and v > 100_000,
        "stage_id": "collection",
        "signal_strength": 0.70,
        "description": lambda v: f"Large inbound transfer ({int(v):,} bytes) — bulk data access",
    },
    {
        "field": "dst_port",
        "condition": lambda v: v in (445, 139),
        "stage_id": "lateral_movement",
        "signal_strength": 0.80,
        "description": lambda v: f"SMB traffic on port {v} — lateral movement vector",
    },
    {
        "field": "dst_port",
        "condition": lambda v: v == 3389,
        "stage_id": "lateral_movement",
        "signal_strength": 0.80,
        "description": lambda v: "RDP connection (port 3389) — remote lateral movement",
    },
    {
        "field": "dst_port",
        "condition": lambda v: v == 22,
        "stage_id": "lateral_movement",
        "signal_strength": 0.70,
        "description": lambda v: "SSH connection (port 22) — lateral movement or C2 channel",
    },
    {
        "field": "dst_port",
        "condition": lambda v: v == 53,
        "stage_id": "command_and_control",
        "signal_strength": 0.75,
        "description": lambda v: "DNS traffic (port 53) — possible DNS tunnelling C2",
    },
    {
        "field": "protocol",
        "condition": lambda v: isinstance(v, str) and v.upper() == "ICMP",
        "stage_id": "command_and_control",
        "signal_strength": 0.75,
        "description": lambda v: "ICMP protocol — possible covert C2 channel",
    },
    {
        "field": "severity",
        "condition": lambda v: v is not None and v >= 4,
        "stage_id": "impact",
        "signal_strength": 0.80,
        "description": lambda v: f"Critical severity ({v}/5) — active high-impact attack",
    },
    {
        "field": "severity",
        "condition": lambda v: v is not None and v == 3,
        "stage_id": "execution",
        "signal_strength": 0.75,
        "description": lambda v: "High severity event — malicious code execution likely",
    },
    {
        "field": "is_foreign_request",
        "condition": lambda v: v == 1,
        "stage_id": "initial_access",
        "signal_strength": 0.80,
        "description": lambda v: "Request originated from foreign geography — initial access vector",
    },
    {
        "field": "device_is_new",
        "condition": lambda v: v == 1,
        "stage_id": "initial_access",
        "signal_strength": 0.75,
        "description": lambda v: "Unrecognised device — possible new attacker endpoint",
    },
    {
        "field": "duration_s",
        "condition": lambda v: v is not None and v > 3600,
        "stage_id": "command_and_control",
        "signal_strength": 0.70,
        "description": lambda v: f"Long-lived session ({v:.0f}s) — persistent C2 beacon",
    },
]

# SHAP feature -> stage hint and description
SHAP_FEATURE_SIGNALS: dict[str, dict[str, Any]] = {
    "f_device_past_hisev_count": {
        "stage_id": "execution",
        "signal_strength": 0.90,
        "description": lambda v, shap: (
            f"Device has {int(v)} prior high-severity events — repeat attacker target"
            if v and v > 0 else "Elevated device threat history — execution indicator"
        ),
    },
    "f_user_seq_no": {
        "stage_id": "initial_access",
        "signal_strength": 0.70,
        "description": lambda v, shap: "Low user sequence number — limited history, possible new attacker account",
    },
    "f_user_secs_since_last": {
        "stage_id": "initial_access",
        "signal_strength": 0.55,
        "description": lambda v, shap: (
            f"Unusually long gap ({v/3600:.1f}h) since last activity — account re-use after dormancy"
            if v and v > 3600 else "Atypical activity timing"
        ),
    },
    "bytes_out": {
        "stage_id": "exfiltration",
        "signal_strength": 0.85,
        "description": lambda v, shap: f"Outbound byte volume (SHAP={shap:+.3f}) — exfiltration signal",
    },
    "bytes_in": {
        "stage_id": "collection",
        "signal_strength": 0.65,
        "description": lambda v, shap: f"Inbound byte volume (SHAP={shap:+.3f}) — data collection signal",
    },
    "dst_port": {
        "stage_id": "lateral_movement",
        "signal_strength": 0.70,
        "description": lambda v, shap: f"Destination port {v} flagged — lateral movement or C2 vector",
    },
    "protocol": {
        "stage_id": "command_and_control",
        "signal_strength": 0.65,
        "description": lambda v, shap: f"Protocol '{v}' contributed to risk — possible covert channel",
    },
    "duration_s": {
        "stage_id": "command_and_control",
        "signal_strength": 0.60,
        "description": lambda v, shap: f"Connection duration {v:.0f}s — long-lived session indicator",
    },
    "severity": {
        "stage_id": "impact",
        "signal_strength": 0.75,
        "description": lambda v, shap: f"Severity level {v} — high-impact event classification",
    },
    "f_geo_distance_km": {
        "stage_id": "initial_access",
        "signal_strength": 0.70,
        "description": lambda v, shap: f"Geographic anomaly ({v:.0f} km from baseline) — impossible travel or VPN bypass",
    },
    "is_foreign_request": {
        "stage_id": "initial_access",
        "signal_strength": 0.75,
        "description": lambda v, shap: "Foreign request origin — initial access from unexpected geography",
    },
    "device_is_new": {
        "stage_id": "initial_access",
        "signal_strength": 0.70,
        "description": lambda v, shap: "New device — unrecognised endpoint used for access",
    },
    "src_port": {
        "stage_id": "command_and_control",
        "signal_strength": 0.55,
        "description": lambda v, shap: f"Source port {v} — non-standard port suggests C2 beaconing",
    },
}

DEFAULT_STAGE_ID = "execution"
