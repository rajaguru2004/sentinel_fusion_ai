/**
 * Manual run of the model history backfill (SentinelBackfill).
 *
 *   npm run demo:warm-history
 *
 * The backend does this automatically at boot, but the model's feature store is
 * in-memory by default: restart the MODEL and the bank keeps running with a
 * store that has forgotten every customer, at which point routine payments score
 * as anomalies. This re-seeds it without bouncing the bank.
 */
// Same .env bootstrap main.ts does — this entrypoint never goes through it.
try {
  process.loadEnvFile?.();
} catch {
  // Ignore if .env is missing or already loaded
}

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module';
import { SentinelBackfill } from '../fraud/sentinel-backfill.service';
import { env } from '../common/env';

async function main(): Promise<void> {
  const log = new Logger('warm-model-history');
  if (!env.sentinel.enabled) {
    log.warn('SENTINEL_ENABLED is false — nothing to warm.');
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const { sent, skipped } = await app.get(SentinelBackfill).run();
    log.log(`Done: ${sent} ingested, ${skipped} failed (${env.sentinel.url})`);
    if (skipped > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
