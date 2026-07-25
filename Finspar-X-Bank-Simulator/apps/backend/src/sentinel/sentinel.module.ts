import { Module } from '@nestjs/common';
import { SentinelController } from './sentinel.controller';
import { SentinelService } from './sentinel.service';

/**
 * Browser-facing proxy to the Sentinel model, for the Sentinel Console screen.
 * Always registered; the service returns 503 with a fix hint when
 * SENTINEL_ENABLED is off, which is friendlier than a 404 on a missing route.
 */
@Module({
  controllers: [SentinelController],
  providers: [SentinelService],
})
export class SentinelModule {}
