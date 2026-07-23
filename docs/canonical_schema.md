# Canonical Banking Event Schema v2

Supersedes the financial half of [`unified_schema.md`](unified_schema.md). The security
core columns are unchanged; this document adds the **banking block** and defines the rule
that governs it.

## The rule

> A column is canonical **only if the FinSpark bank simulator can supply it at scoring time.**

The v1 schema was security-shaped: datasets were mapped into it and whatever did not fit was
packed into an `attributes` JSON blob. That blob was then dropped when the training corpus was
built (`notebooks/src/11_unify.py`), so every source's native features were silently discarded.

v2 inverts the direction of design. The bank contract defines the schema; datasets are mapped
*into* it. A feature that only one dataset has is worthless at serving time because the bank
cannot send it — so it stays in `attributes`, is marked **source-local** below, and never
enters a model contract. This is what stops the corpus from teaching the model signals that
vanish in production.

---

## Banking block

All columns are optional and NaN-safe (the GBMs consume NaN natively; `IsolationForest` paths
impute via `ml/features.py::impute`).

### Counterparty
| column | type | meaning |
|---|---|---|
| `counterparty_id` | string | payee / merchant / destination account |
| `counterparty_country` | category | ISO-3166 alpha-2 |
| `counterparty_is_new` | Int8 | first payment to this counterparty by this user |
| `counterparty_age_s` | float64 | seconds since counterparty was added (bank: `beneficiaryAgeMinutes` × 60) |
| `name_mismatch` | Int8 | payee name ≠ account-holder name (bank: `nameMismatch`) |

### Account state
| column | type | meaning |
|---|---|---|
| `balance_before` | float64 | originator balance pre-transaction |
| `balance_after` | float64 | originator balance post-transaction |
| `counterparty_balance_before` | float64 | destination balance pre-transaction |
| `counterparty_balance_after` | float64 | destination balance post-transaction |

### Customer
| column | type | meaning |
|---|---|---|
| `customer_age` | float64 | years |
| `account_age_s` | float64 | seconds since account opened |
| `income` | float64 | normalized income band |

### Channel / device
| column | type | meaning |
|---|---|---|
| `channel` | category | `web`, `mobile`, `atm`, `pos`, `branch`, `api` |
| `device_os` | category | |
| `device_is_new` | Int8 | first time this user used this device |
| `session_length_s` | float64 | |
| `is_foreign_request` | Int8 | request origin ≠ account country |
| `email_is_free` | Int8 | free email provider |

### Merchant
| column | type | meaning |
|---|---|---|
| `merchant_id` | string | |
| `merchant_category` | category | MCC-equivalent |

### Geo
| column | type | meaning |
|---|---|---|
| `country` | category | actor country (already in v1 core) |
| `geo_lat`, `geo_lon` | float64 | actor location |
| `counterparty_lat`, `counterparty_lon` | float64 | counterparty / merchant location |

### Transaction
| column | type | meaning |
|---|---|---|
| `amount` | float64 | already in v1 core |
| `currency` | category | ISO-4217 |
| `payment_type` | category | `transfer`, `cash_out`, `cash_in`, `debit`, `payment`, `card_purchase` |
| `is_credit` | Int8 | direction: 1 = money in |

### Bank-computed (requirements doc §3.3)
Signals FinSpark already computes. Accepted as trained features **and** as cold-store fallback
seeds.

| column | type | bank field |
|---|---|---|
| `bank_txn_count_1h` | float64 | `txnCountLastHour` |
| `bank_amount_vs_user_mean` | float64 | `amountVsUserMean` |
| `bank_beneficiary_age_s` | float64 | `beneficiaryAgeMinutes` × 60 |
| `bank_is_new_beneficiary` | Int8 | `isNewBeneficiary` |

**Precedence.** The store-computed `f_*` feature wins whenever it is non-NaN. The `bank_*`
value is used as a fallback seed when the store is cold, *and* is exposed as an independent
trained feature so the model can weigh the bank's own view. Both paths are covered by tests.

---

## Source coverage matrix

`●` populated · `◐` partial or proxy · `○` absent · `L` source-local (stays in `attributes`,
never a model feature)

| canonical field | paysim | creditcard | baf | **sparkov** | finspark (sim) |
|---|:--:|:--:|:--:|:--:|:--:|
| `user_id` | ◐ near-unique | ○ | ○ | **● `cc_num`** | ● |
| `amount` | ● | ● | ◐ credit limit | ● `amt` | ● |
| `payment_type` | ● `type` | ○ | L opaque code | ◐ card_purchase | ● |
| `counterparty_id` | ● `nameDest` | ○ | ○ | ● `merchant` | ● |
| `counterparty_is_new` | derived | ○ | ○ | derived | ● |
| `counterparty_age_s` | ○ | ○ | ○ | ○ | ● |
| `name_mismatch` | ○ | ○ | ○ | ○ | ● |
| `balance_before` / `after` | ● | ○ | ○ | ○ | ● |
| `counterparty_balance_*` | ● | ○ | ○ | ○ | ● |
| `customer_age` | ○ | ○ | ● | ● from `dob` | ● |
| `account_age_s` | ○ | ○ | ◐ `bank_months_count` | ○ | ● |
| `income` | ○ | ○ | ● | ○ | ● |
| `channel` | ◐ mobile | ◐ card | ○ | ◐ pos/net from `category` | ● |
| `device_os` | ○ | ○ | ● | ○ | ● |
| `session_length_s` | ○ | ○ | ● | ○ | ● |
| `is_foreign_request` | ○ | ○ | ● | ○ | ● |
| `email_is_free` | ○ | ○ | ● | ○ | ● |
| `merchant_id` | ○ | ○ | ○ | ● | ● |
| `merchant_category` | ○ | ○ | ○ | ● `category` | ● |
| `geo_lat` / `geo_lon` | ○ | ○ | ○ | ● | ● |
| `counterparty_lat` / `lon` | ○ | ○ | ○ | ● `merch_*` | ● |
| `bank_*` block | ○ | ○ | ○ | ○ | ● |

**Source-local (`L`) — excluded from every model contract:**
- creditcard `V1..V28` — PCA components of unpublished features. Unreconstructable by any bank.
- baf `payment_type` / `employment_status` / `housing_status` — anonymized codes (`AA`, `CB`,
  `BA`) with no documented mapping; not the same semantic as FinSpark's `payment_type`.
- baf `credit_risk_score`, `velocity_6h/24h/4w` — bureau/velocity aggregates on an undisclosed
  scale. Kept in `attributes`; the *concept* is reproduced by `bank_txn_count_1h` and the
  store-computed velocity features instead.
- paysim `isFlaggedFraud`, `step`.

---

## Sequence coverage — why Sparkov was acquired

The fraud model's history features (`f_user_seq_no`, `f_user_secs_since_last`,
`f_amount_z_user`, `f_amount_ratio_mean`) were dead: **0% of fraud training rows had any user
history**, because no financial source supplied usable per-customer sequences.

Measured txns-per-entity:

| source | entity key | distinct entities | txns / entity | usable history |
|---|---|---:|---:|:--:|
| paysim | `nameOrig` | 158,262 (of 158,265 rows) | **1.0** | no |
| creditcard | — | — | — | no |
| baf | — | — | — | no |
| **sparkov** | **`cc_num`** | **999** | **1,854** | **yes** |
| finspark | account id | configurable | configurable | yes |

Sparkov: 1,852,394 rows, 999 cards, 693 merchants, 2019-01-01 → 2020-12-31, fraud rate
0.521%, median **1,471** transactions per card, 908/999 cards with ≥100 transactions. It is
the only public source in the corpus that can teach velocity and amount-vs-history.

### Verified signal (and one non-signal)

| signal | benign | fraud | spread |
|---|---:|---:|---:|
| median amount | 47.24 | 390.00 | 8.3× |
| fraud rate, hours 22–03 | 0.10% | — | 13–26× vs daytime |
| fraud rate, `shopping_net` vs `health_fitness` | 0.15% | 1.59% | 10.6× |
| **geo distance customer→merchant** | **76.1 km** | **76.3 km** | **none** |

Merchant coordinates are generated independently of the label, so **`f_geo_distance_km` is
inert on Sparkov** and can only be learned from the simulator. Recorded here so the feature's
weakness is not mistaken for an implementation bug.

Non-leak check: the `fraud_` prefix appears on **100%** of merchant names, not only fraudulent
ones — it is a naming artifact of the generator, not a target leak.

---

## Licensing

| source | licence | commercial use |
|---|---|---|
| **sparkov** | **CC0-1.0** | **unrestricted** |
| creditcard | DbCL v1.0 | permitted |
| paysim | CC BY-SA 4.0 | share-alike |
| baf | CC BY-NC-SA 4.0 | **non-commercial only** |
| rba | see `data/raw/behaviour/rba/LICENSE` | research |

BAF is the only financial source that cannot ship in a commercial product. It remains in the
research corpus, and the `fraud_application` head trained on it is marked non-commercial in
`reports/ml/MODELS.md`. The `fraud_payment` head — the one on the bank's money path — is
trained on CC0 + CC BY-SA + simulator data only.

---

## `severity` is not a feature and must stop being label-derived

Measured agreement of `severity >= 3` with `label == 1` in the v1 corpus:

```
baf 1.0000   beth 1.0000   creditcard 1.0000   paysim 1.0000   rba 1.0000
cicids2017 0.9965   quantum_synth 0.9791
```

`severity` was assigned as `3 if fraud else 0` by the loaders, making it a perfect alias of the
target. It is correctly excluded from every feature list — but `ml/feature_core.py::advance_device`
builds `f_device_past_hisev_count` from it, turning that feature into a running count of past
*confirmed-malicious* events. Online, `severity` arrives from the bank as an ex-ante triage
field, so the two are not the same variable.

**v2 rule:** `severity` is an ex-ante, source-declared triage level, never a function of
`label`. Financial loaders emit `0`. `f_device_past_hisev_count` is dropped from the fraud and
behaviour contracts.
