# Sentinel Fusion AI — Unified Event Schema v1.0

One row = one event. All five domains map into this schema. Domain-specific detail preserved in `attributes` (JSON string) — core columns stay fixed for ML.

## Core columns

| Column | Type | Required | Description |
|---|---|---|---|
| `event_id` | string | yes | Globally unique. `{source_dataset}-{seq}` |
| `event_time` | datetime64[ns, UTC] | yes | Normalized UTC timestamp. Synthetic epoch assigned where source lacks absolute time (documented per dataset) |
| `event_domain` | category | yes | `cyber` \| `financial` \| `behaviour` \| `threat_intel` \| `quantum` |
| `event_type` | category | yes | Normalized type, e.g. `network_flow`, `process_exec`, `card_txn`, `login`, `ioc_url`, `tls_handshake` |
| `event_subtype` | category | no | Finer grain, e.g. `dns`, `wire_transfer`, `privilege_escalation` |
| `source_dataset` | category | yes | Provenance: `unsw_nb15`, `beth`, `cicids2017`, `creditcard`, `paysim`, `baf`, `rba`, `cert_insider`, `urlhaus`, `mitre_attack`, `cisa_kev`, `feodo`, `malicious_urls`, `quantum_synth` |
| `user_id` | string | no | Actor identifier (hashed/anonymous where source anonymized) |
| `device_id` | string | no | Device / host / endpoint identifier |
| `src_ip` | string | no | Source IP |
| `dst_ip` | string | no | Destination IP |
| `src_port` | Int32 | no | Source port |
| `dst_port` | Int32 | no | Destination port |
| `protocol` | category | no | `tcp`, `udp`, `icmp`, … |
| `country` | category | no | ISO-3166 alpha-2 of actor/source |
| `amount` | float64 | no | Monetary value (financial events), normalized units of source |
| `duration_s` | float64 | no | Session/flow/txn duration in seconds |
| `bytes_in` | float64 | no | Bytes received (dst→src) |
| `bytes_out` | float64 | no | Bytes sent (src→dst) |
| `severity` | Int8 | yes | 0=info, 1=low, 2=medium, 3=high, 4=critical. Mapped per dataset (documented) |
| `label` | Int8 | yes | 0=benign, 1=malicious/fraud/anomalous, -1=unlabeled (threat-intel context rows) |
| `label_type` | category | yes | What label means: `attack`, `fraud`, `insider`, `account_takeover`, `ioc`, `quantum_risk`, `none` |
| `attack_technique` | string | no | MITRE ATT&CK technique ID (`T1059`, …) where mappable |
| `attributes` | string (JSON) | no | Domain-specific fields not in core schema, lossless |

## Temporal ordering

Final unified dataset sorted by (`event_time`, `event_id`). Datasets with only relative time (BETH monotonic ts, PaySim step-hours, BAF month) get documented synthetic epoch anchors — see `docs/data_dictionary.md`. `time_is_synthetic` flag column (bool) marks these.

## Domain mapping summary

| Dataset | event_domain | event_type | label source |
|---|---|---|---|
| UNSW-NB15 | cyber | network_flow | `label` (attack_cat → event_subtype) |
| BETH | cyber | process_exec | `sus`/`evil` |
| CIC-IDS2017 | cyber | network_flow | `Label` (attack name → event_subtype) |
| Credit Card (ULB) | financial | card_txn | `Class` |
| PaySim | financial | mobile_txn | `isFraud` |
| Bank Account Fraud | financial | account_open | `fraud_bool` |
| RBA logins | behaviour | login | `Is Attack IP` ∨ `Is Account Takeover` |
| CERT insider | behaviour | logon/device/file/http/email | insider list membership |
| URLhaus / malicious URLs / Feodo | threat_intel | ioc_url / ioc_ip | 1 (IOC) or type column |
| MITRE ATT&CK / CISA KEV | threat_intel | technique / cve | -1 (context) |
| Quantum synthetic | quantum | tls_handshake / cert_inventory | HNDL-risk heuristic |

## Files

- `data/clean/<dataset>.parquet` — cleaned per-dataset, native columns
- `data/unified/unified_events.parquet` — all datasets, this schema
- `data/unified/unified_events_engineered.parquet` — + engineered features
