# Validation Report — Unified Dataset

- Rows: **2,043,664**, columns: **42**
- Overall pass: **True**
- Duplicate event_ids: 0
- Invalid timestamps: 0; future: 101
- Invalid labels: 0
- Positive rate (labeled rows): 0.40243
- Synthetic-time share: 0.6699
- Consistency issues: none

## Positive rate by dataset

- `baf`: 0.06859 (160,800 rows)
- `beth`: 0.50017 (299,777 rows)
- `cicids2017`: 1.0 (149,866 rows)
- `creditcard`: 0.00314 (150,604 rows)
- `feodo`: 1.0 (5 rows)
- `malicious_urls`: 0.49969 (299,656 rows)
- `paysim`: 0.05189 (158,265 rows)
- `quantum_synth`: 0.03469 (155,468 rows)
- `rba`: 0.4995 (300,648 rows)
- `unsw_nb15`: 0.44936 (145,222 rows)
- `urlhaus`: 1.0 (71,042 rows)

## Leakage notes

- **engineered_features**: All rolling/historical features use shift(1) — past-only; verified in 12_feature_engineering.
- **synthetic_timestamps**: Datasets with synthetic times are flagged time_is_synthetic; do NOT use cross-dataset temporal joins on them.
- **paysim_isFlaggedFraud**: Kept only inside attributes JSON; it is a rule output, treat as feature not label.
- **quantum_synth**: Label is rule-derived from features by construction — model will learn the rule; use for pipeline validation, not as evidence of real-world quantum-risk predictive power.
- **beth_sus**: sus kept in attributes; correlated with evil label — drop if predicting evil strictly.
- **train_test_reuse**: UNSW/BETH official splits preserved in attributes.split for honest evaluation.