-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "customerAge" INTEGER,
ADD COLUMN     "incomeBand" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "fraud_events" ADD COLUMN     "eventId" TEXT;

-- CreateIndex
CREATE INDEX "fraud_events_eventId_idx" ON "fraud_events"("eventId");
