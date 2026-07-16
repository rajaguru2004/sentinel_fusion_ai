# Data Dictionary — Sentinel Fusion AI Phase 1

## Datasets collected

| # | Dataset | Domain | Source | License | Rows (approx) | Labels | Real timestamps | Production suitability |
|---|---|---|---|---|---|---|---|---|
| 1 | UNSW-NB15 | cyber | Kaggle `dhoogla/unswnb15` | CC BY 4.0 | 258k flows | binary + 9 attack cats | no → synthetic (capture windows 2015-01-22 / 2015-02-17) | HIGH |
| 2 | BETH | cyber | Kaggle `katehighnam/beth-dataset` | CC BY 4.0 | ~1.14M process events | `sus`, `evil` | sec-since-boot → anchored 2021-05-01 | HIGH |
| 3 | CIC-IDS2017 (cleaned) | cyber | Kaggle `ericanacletoribeiro/cicids2017-cleaned-and-preprocessed` | CIC research terms | ~2.5M flows | attack type (15 classes) | no → synthetic capture week 2017-07-03..07 | HIGH |
| 4 | ULB Credit Card | financial | Kaggle `mlg-ulb/creditcardfraud` | DbCL 1.0 | 285k txns | `Class` fraud 0.17% | relative sec → anchored 2013-09-01 | HIGH |
| 5 | PaySim | financial | Kaggle `ealaxi/paysim1` | CC BY-SA 4.0 | 6.36M txns | `isFraud` | step-hours → anchored 2023-01-01 | HIGH |
| 6 | Bank Account Fraud (Base) | financial | Kaggle `sgpjesus/bank-account-fraud-dataset-neurips-2022` | CC BY-NC-SA 4.0 | 1M applications | `fraud_bool` ~1.1% | month only → synthetic within month, anchor 2022-01 | HIGH (research-only license) |
| 7 | RBA logins | behaviour | Kaggle `dasgroup/rba-dataset` | CC BY-NC 4.0 | 33M logins (sampled: all attacks + 6% benign) | `Is Attack IP`, `Is Account Takeover` | YES (real) | HIGH |
| 8 | CERT Insider Threat r4.2 (subset) | behaviour | Kaggle `nitishabharathi/cert-insider-threat` | CMU/CERT research | multi-file logon/device/file/email | insider scenarios | YES (simulated org, real format) | MEDIUM-HIGH (synthetic org) |
| 9 | URLhaus | threat_intel | abuse.ch live dump | CC0 | ~all recent IOC URLs | all malicious | YES | HIGH |
| 10 | Malicious URLs | threat_intel | Kaggle `sid321axn/malicious-urls-dataset` | aggregated academic | 651k URLs | benign/defacement/phishing/malware | no → synthetic | MEDIUM |
| 11 | Feodo Tracker | threat_intel | abuse.ch live | CC0 | C2 IP list | all malicious | YES | HIGH |
| 12 | CISA KEV | threat_intel | cisa.gov | public domain | ~1.3k CVEs | context (-1) | YES | HIGH |
| 13 | MITRE ATT&CK Enterprise | threat_intel | github.com/mitre/cti | MITRE (attribution) | ~800 techniques | context (-1) | YES (created dates) | HIGH |
| 14 | Quantum synth | quantum | generated (10_quantum_synth) | n/a | 250k TLS events | rule-based HNDL | synthetic 2025 | Synthetic — pipeline validation |

## Unified schema

See [unified_schema.md](unified_schema.md). 24 columns; per-dataset native detail preserved in `attributes` JSON.

## Severity mapping rationale

- 0 info/benign, 1 low (non-PQC but normal), 2 medium (recon, fuzzing, sus, defacement),
  3 high (DoS, exploits, fraud, phishing, attack-IP logins), 4 critical (backdoors, worms,
  C2, ATO, ransomware-linked CVEs, HNDL-critical).

## Timestamp anchors (synthetic times)

| Dataset | Anchor | Basis |
|---|---|---|
| UNSW-NB15 | 2015-01-22 / 2015-02-17 (16h windows) | official capture dates |
| BETH | 2021-05-01 + sec-since-boot | dataset publication window; order-preserving |
| CIC-IDS2017 | 2017-07-03..07 business hours | official capture week |
| Credit Card | 2013-09-01 + `Time` | documented capture (Sept 2013, 2 days); order-preserving |
| PaySim | 2023-01-01 + step-hours | arbitrary; order-preserving |
| BAF | 2022-01-01 + month*30d | arbitrary; month-order preserving |
| Malicious URLs | uniform over 2021-H1 | no time info at all |
| Quantum synth | uniform over 2025 | generated |

All flagged `time_is_synthetic=True`. Cross-dataset temporal correlation only valid on real-timestamp sources.

## Known quality issues (kept, documented)

- CICIDS2017: `Flow Bytes/s`, `Flow Packets/s` inf artifacts → median-imputed; negative durations dropped.
- PaySim: balance-equation inconsistencies (~known artifact) kept as `orig_balance_inconsistent` feature.
- BAF: `-1` sentinel missing values → NaN + `_missing` indicators.
- RBA: benign downsampled 6% (all attack rows kept) — restore weights via `sampling_weight` ≈ 16.7 for benign when estimating population rates.
- CERT r4.2: synthetic organization; ground-truth insiders from scenario answers (see notebook 08).
