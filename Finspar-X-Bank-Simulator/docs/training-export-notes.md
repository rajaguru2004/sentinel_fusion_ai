# FinSpark Training Export — answers to the spec's open questions

Companion to the generator `apps/backend/src/tools/export-training.ts` and the
contract `sentinel_fusion_ai/docs/finspark_export_spec.md`. These answer the four
open questions the spec raises for the bank team.

Run: `npm run export:training -- --customers 9000 --out ./exports/finspark`
(defaults produce a spec-valid corpus; the run self-checks against the spec's
on-receipt assertions and prints PASS/FAIL).

## 1. Can the simulator emit `confirmedAt`, or should Sentinel apply synthetic lag?

**Yes — `confirmedAt` is emitted on every labeled event** (`value != -1`). Live,
it is the moment the bank learned the truth: the customer fraud report
(`disputes.report()`) now closes the model feedback loop via `POST /feedback`,
and that confirmation time is the real `confirmedAt`. In the synthetic export we
model the lag explicitly: fraud is learned 3–45 days later (chargeback / SOC
review), benign clears in 0.2–7 days (settlement). No synthetic-lag fallback is
required, but the spec's 7-day / 60% default remains a safe backstop.

## 2. One run or chunked?

**Chunked, transparently.** The generator streams NDJSON and rolls to a new file
every `--events-per-file` events (default 250k), producing
`events_<YYYYMMDD>_<seq>.jsonl` in order. A 2M-event / ~9k-customer corpus is one
command (`--customers 9000`) but lands as ~8 files. Memory is O(1) in event
count — it never buffers the corpus — so the full run is feasible on the 16 GB box.

## 3. Are `counterparty.balanceBefore/After` available?

**Yes, for own-bank counterparties.** Live, `FraudGateway.buildPaymentEvent()`
resolves the beneficiary's internal `Account` (when `isOwnBank`) and sends
`counterparty_balance_before/after`. External beneficiaries have no internal
ledger, so those stay null (the model treats missing as NaN). The export mirrors
this: own-bank counterparties carry both fields, external ones omit them.

## 4. Does the simulator model repeat offenders?

**Yes.** ~3% of synthetic customers are flagged fraud-prone and carry a much
higher per-payment fraud probability, so fraud concentrates in a minority of
entities across their complete sequences — exactly the signal
`f_user_past_malicious_rate` needs. This is why full customer sequences are never
subsampled.

## Guarantees honored by the generator

- `eventId` globally unique (`evt_<customer>_<seq>`); monotone `eventTime` per
  customer, ties broken by `eventId`.
- Complete sequences per customer — never subsampled.
- Fraud NOT pre-balanced; default lands ~0.1–0.5% of scored events (within the
  spec's 0.05–2.0% receipt bound).
- **No label-derived fields** (`severity`, `riskScore`, `isFlagged`) in any payload.
- `bankComputed` present on 100% of `payment_initiation` events (spec wants ≥60%).
