-- Money-path idempotency key (ENHANCEMENTS.md §1).
--
-- One payment produces exactly one DEBIT and one CREDIT row, so this index makes
-- a second postPayment() for the same payment abort on the constraint and roll
-- its transaction back. A double-clicked submit, a retried request and a re-run
-- cut-off job therefore cannot post twice.
--
-- `paymentId` is nullable (opening balances / external credits carry no payment)
-- and Postgres treats NULLs as distinct in a unique index, so those rows are
-- unaffected and any number of them may coexist.

-- Defensive: collapse any pre-existing duplicates before the index is built, so
-- the migration cannot fail on historical demo data. Keeps the earliest row of
-- each (paymentId, direction) group.
DELETE FROM "ledger_entries" a
      USING "ledger_entries" b
      WHERE a."paymentId" IS NOT NULL
        AND a."paymentId" = b."paymentId"
        AND a."direction"  = b."direction"
        AND a."postedAt"   > b."postedAt";

CREATE UNIQUE INDEX "ledger_entries_paymentId_direction_key"
    ON "ledger_entries" ("paymentId", "direction");
