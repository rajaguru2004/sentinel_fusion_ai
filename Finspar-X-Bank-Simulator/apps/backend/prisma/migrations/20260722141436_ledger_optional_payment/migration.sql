-- DropForeignKey
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_paymentId_fkey";

-- DropIndex
DROP INDEX "ledger_entries_accountId_idx";

-- AlterTable
ALTER TABLE "ledger_entries" ADD COLUMN     "description" TEXT,
ADD COLUMN     "valueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "paymentId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ledger_entries_accountId_postedAt_idx" ON "ledger_entries"("accountId", "postedAt");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
