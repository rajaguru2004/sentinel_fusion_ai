-- CreateTable
CREATE TABLE "app_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "alertEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertMinLevel" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "blockEnabled" BOOLEAN NOT NULL DEFAULT true,
    "blockMinLevel" "RiskLevel" NOT NULL DEFAULT 'CRITICAL',
    "perTxnLimitPaise" BIGINT NOT NULL DEFAULT 250000000,
    "cutoffEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cutoffHour" INTEGER NOT NULL DEFAULT 19,
    "cutoffMinute" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);
