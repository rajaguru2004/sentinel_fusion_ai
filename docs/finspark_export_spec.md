# FinSpark Simulator — Training Export Spec

**Audience:** the FinSpark bank team (NestJS).
**Purpose:** define the labeled event export that Sentinel Fusion AI trains and calibrates on.
**Status:** contract proposal — needs sign-off before Phase 2 loaders are written.

## Why this export exists

Two things cannot be obtained from public data:

1. **Bank-shaped context signals.** `nameMismatch`, `beneficiaryAgeMinutes`,
   `isNewBeneficiary` and the counterparty lifecycle do not exist in any public fraud dataset.
   Public data can teach amount/velocity/temporal patterns; only FinSpark can teach these.
2. **The operating distribution.** The current fraud threshold was picked to maximize F1 on a
   corpus whose fraud base rate is 3.4%. At a realistic bank base rate the same threshold gives
   precision **0.046**. Thresholds and the isotonic calibrators must be fitted on FinSpark
   traffic or the risk bands (`<.25 / .50 / .75`) do not mean what the bank's decision logic
   assumes they mean.

This export is therefore both a **training corpus** and the **calibration authority**.

---

## Format

- **File:** newline-delimited JSON (`.jsonl`) or Parquet, one object per event.
- **Location:** `data/raw/financial/finspark/`.
- **Naming:** `events_<YYYYMMDD>_<seq>.jsonl` — chronological, append-only.
- **Ordering:** ascending `eventTime` within a file. Files need not overlap.
- **Encoding:** UTF-8, `camelCase` keys (matches the bank's existing style; the loader
  snake_cases them).

## Volume target

| slice | target | why |
|---|---|---|
| total events | ≥ 2,000,000 | comparable to the whole current corpus |
| distinct customers | 5,000 – 50,000 | enough entities without exploding the 16 GB box |
| events per customer | median ≥ 200 | velocity/history features need real sequences |
| span | ≥ 6 months | seasonality + counterparty ageing |
| fraud rate | 0.1% – 1.0% | realistic; do **not** oversample |

**Do not pre-balance the classes.** Class imbalance is handled by `scale_pos_weight` at
training time, and the true base rate is exactly the thing that must be preserved for
calibration to be meaningful.

---

## Event envelope

Every event, all types:

```jsonc
{
  "eventId":     "evt_01HXYZ...",     // required, globally unique, idempotency key
  "eventTime":   "2026-07-23T14:05:00.000Z",  // required, tz-aware ISO-8601 UTC
  "eventType":   "payment_initiation", // required, see table
  "userId":      "cust-8841",          // required where an actor exists
  "deviceId":    "dev-a91f",
  "sessionId":   "sess-77c1",
  "channel":     "mobile",             // web | mobile | atm | pos | branch | api
  "country":     "GB",
  "label":       { /* see Labels */ }
}
```

### Event types

| `eventType` | scored? | purpose |
|---|---|---|
| `payment_initiation` | **yes** — `/score` | the money path; the primary training target |
| `login` | yes — `/score` | routed to the behaviour model |
| `beneficiary_add` | no — `/ingest` | starts the counterparty ageing clock |
| `beneficiary_activate` | no — `/ingest` | |
| `card_purchase` | yes — `/score` | comparable to Sparkov |
| `balance_check`, `statement_view` | no — `/ingest` | low-value context; builds velocity |

Context events matter as much as scored ones. They are what makes `f_user_seq_no` and
`f_user_secs_since_last` non-degenerate, and they are the reason `POST /ingest` exists.

---

## Payload — `payment_initiation`

```jsonc
{
  "amount":       4210.55,
  "currency":     "GBP",
  "paymentType":  "transfer",        // transfer | cash_out | cash_in | debit | payment
  "isCredit":     false,

  "balanceBefore": 18400.00,
  "balanceAfter":  14189.45,

  "counterparty": {
    "id":            "bene-3312",
    "country":       "GB",
    "isNew":         true,
    "ageSeconds":    300,            // = beneficiaryAgeMinutes * 60
    "nameMismatch":  true,
    "balanceBefore": 220.00,
    "balanceAfter":  4430.55,
    "lat": 51.5072, "lon": -0.1276
  },

  "customer": {
    "age":            34,
    "accountAgeSeconds": 63072000,
    "income":         0.62,          // normalized band, 0..1
    "emailIsFree":    1
  },

  "device": {
    "os":        "iOS",
    "isNew":     false,
    "sessionLengthSeconds": 214,
    "isForeignRequest": 0
  },

  "geo": { "lat": 51.5072, "lon": -0.1276 },

  "bankComputed": {                  // the bank's own signals — requirements doc §3.3
    "txnCountLastHour":   7,
    "amountVsUserMean":   12.4,
    "beneficiaryAgeMinutes": 5,
    "isNewBeneficiary":   true
  }
}
```

`bankComputed` is **not** redundant with the store-computed features. It is trained as an
independent view and used as a cold-store fallback. Send it even when it duplicates something
Sentinel could compute itself.

### `merchant` (for `card_purchase`)

```jsonc
"merchant": { "id": "mrc-7781", "category": "grocery_pos", "lat": 51.51, "lon": -0.12 }
```

---

## Labels

```jsonc
"label": {
  "value":        1,                          // 0 benign | 1 fraud | -1 unknown
  "type":         "fraud",                    // fraud | account_takeover | none
  "confirmedAt":  "2026-07-30T09:12:00.000Z", // when the bank *learned* the truth
  "source":       "chargeback"                // chargeback | soc_review | customer_report | rule
}
```

`confirmedAt` is **required for every label with `value != -1`** and is the single most
important field in this spec after `eventTime`.

### Why `confirmedAt` matters

`f_user_past_malicious_rate` is currently built offline as if labels were known instantly. In
production it is driven by `POST /feedback`, which arrives days later and only for a fraction
of events. Training on instant labels and serving on lagged ones is a silent distribution
shift — and `tests/unit/test_feature_parity.py` cannot detect it, because its replay injects
the label the moment the event is scored.

With `confirmedAt`, the offline feature builder can replay labels at the time the bank actually
learned them, so the training distribution matches the serving one. Without it, this feature
has to be dropped entirely.

If the simulator cannot model confirmation lag, say so — the fallback is a documented synthetic
lag (default 7 days, 60% confirmation rate), which is strictly worse but workable.

### Unlabeled events

Context events (`balance_check`, `beneficiary_add`) carry `{"value": -1, "type": "none"}`.
They are used for feature history, never for supervised metrics — the same treatment
`cert_insider` already gets.

---

## Guarantees required

1. **`eventId` globally unique.** It is the idempotency key for `/score` and `/ingest`.
2. **Complete sequences per customer.** Export *all* events for an exported customer. A
   subsampled sequence produces exactly the degenerate history that made the current fraud
   model's velocity features dead — PaySim's 158,262 customers over 158,265 rows is the
   cautionary case.
3. **No label-derived fields in the payload.** No `severity`, `riskScore`, `isFlagged`, or
   rule-engine verdict. If the bank's heuristic score is included it will be learned as the
   target. Send it in a separate `heuristic` object if it is wanted for benchmarking, and it
   will be excluded from feature contracts.
4. **Monotone `eventTime`** within a customer; ties broken by `eventId`.
5. **Stable `userId` / `deviceId` / `counterparty.id`** across the whole export.

---

## Validation on receipt

The Phase 2 loader (`notebooks/src/15_finspark.py`) will assert, and reject the export on
failure:

- `eventId` unique; `eventTime` tz-aware and monotone per customer
- fraud rate within 0.05% – 2.0%
- median events per customer ≥ 200
- ≥ 60% of `payment_initiation` events carry a non-null `bankComputed` block
- every `label.value != -1` has `confirmedAt >= eventTime`
- no field correlates with `label` above |0.98| (the automated leak check that would have
  caught `severity`)

---

## Open questions for the bank team

1. Can the simulator emit `confirmedAt`, or should Sentinel apply a synthetic lag?
2. Is a 6-month, 2M-event, 5k-customer export feasible in one run, or should it be chunked?
3. Are `counterparty.balanceBefore/After` available? PaySim shows destination-balance
   behaviour is a strong fraud signal, and it is otherwise unavailable to us.
4. Does the simulator model repeat offenders (same customer defrauded more than once)? That is
   what makes `f_user_past_malicious_rate` worth keeping at all.
