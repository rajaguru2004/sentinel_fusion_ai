import { Global, Module, Logger } from '@nestjs/common';
import { env } from '../common/env';
import { FraudGateway } from './fraud-gateway.service';
import { HeuristicScorer } from './heuristic-scorer';
import { HttpScorer } from './http-scorer';
import { StubScorer } from './stub-scorer';
import { SentinelIngest } from './sentinel-ingest';
import { SentinelFeedback } from './sentinel-feedback';
import { SentinelWarmup } from './sentinel-warmup';
import { SentinelBackfill } from './sentinel-backfill.service';
import { RiskAlertService } from './risk-alert.service';
import { ScorerHealthService } from './scorer-health.service';
import { LiveAlertsService } from './live-alerts.service';
import { SCORER, type Scorer } from './scorer.interface';

/**
 * SCORER binds by config (env.sentinel.enabled):
 *  - true  -> HttpScorer (Sentinel Fusion AI), which fails open to HeuristicScorer.
 *  - false -> HeuristicScorer (Phase 1). Swap to StubScorer for the pure stub.
 * No call sites change — every money op still goes through FraudGateway.assess().
 */
@Global()
@Module({
  providers: [
    FraudGateway,
    StubScorer,
    HeuristicScorer,
    HttpScorer,
    SentinelIngest,
    SentinelFeedback,
    SentinelWarmup,
    SentinelBackfill,
    RiskAlertService,
    ScorerHealthService,
    LiveAlertsService,
    {
      provide: SCORER,
      inject: [HttpScorer, HeuristicScorer],
      useFactory: (http: HttpScorer, heuristic: HeuristicScorer): Scorer => {
        if (env.sentinel.enabled) {
          new Logger('FraudModule').log(`SCORER -> Sentinel HttpScorer (${env.sentinel.url})`);
          return http;
        }
        new Logger('FraudModule').log('SCORER -> HeuristicScorer (Phase 1)');
        return heuristic;
      },
    },
  ],
  exports: [
    FraudGateway,
    SentinelIngest,
    SentinelFeedback,
    RiskAlertService,
    ScorerHealthService,
    LiveAlertsService,
  ],
})
export class FraudModule {}
