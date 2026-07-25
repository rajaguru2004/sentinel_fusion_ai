import { Injectable, Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import { Agent as HttpAgent } from 'node:http';
import { env } from '../common/env';
import { CORRELATION_HEADER, currentCorrelationId, logTag } from '../common/correlation';
import { HeuristicScorer } from './heuristic-scorer';
import { ScorerHealthService } from './scorer-health.service';
import type { Scorer, UnifiedEvent, RiskVerdict } from './scorer.interface';
import { toEventIn, toRiskVerdict, type SentinelScoreOut } from './sentinel-adapter';

/**
 * Phase 2 scorer — routes UnifiedEvents to the Sentinel Fusion AI model
 * (`POST /score`). Implements the same Scorer interface as HeuristicScorer, so
 * swapping it in is a provider change with no call-site impact.
 *
 * Guardrail: FAIL OPEN. Any error, timeout, or an unscored event falls back to
 * the injected HeuristicScorer so the money path never hangs on a model outage.
 *
 * Every fallback is now recorded on ScorerHealthService (§3), so "we have been
 * scoring on rules for two hours" is a visible state rather than something
 * buried in a log file.
 */
@Injectable()
export class HttpScorer implements Scorer {
  private readonly log = new Logger(HttpScorer.name);
  private readonly http: AxiosInstance;

  constructor(
    private readonly fallback: HeuristicScorer,
    private readonly health: ScorerHealthService,
  ) {
    this.http = axios.create({
      baseURL: env.sentinel.url,
      timeout: env.sentinel.timeoutMs,
      httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 32 }),
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.sentinel.apiKey,
      },
    });
  }

  async score(event: UnifiedEvent): Promise<RiskVerdict> {
    try {
      const { data } = await this.http.post<SentinelScoreOut>(
        '/score?explain=true',
        toEventIn(event),
        {
          // Carry the request's correlation id across the process boundary so the
          // model's own logs join the same timeline (§3).
          headers: correlationHeaders(),
        },
      );

      // Full model response, for visibility in the backend console.
      console.log(
        `\n[Sentinel /score] ${logTag()}${event.eventType} (${event.eventId ?? 'no-id'}) ` +
          `country=${event.country ?? 'unknown'} ->\n` +
          JSON.stringify(data, null, 2),
      );

      // No model covered the event (e.g. threat_intel) — heuristic decides.
      if (!data.scored) {
        this.health.recordFallback('unscored', `no model covered ${data.event_id}`);
        return this.fallback.score(event);
      }

      if (data.degradation?.store_unavailable) {
        this.health.recordStoreUnavailable(data.event_id);
      }
      this.health.recordSuccess();
      return toRiskVerdict(data);
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.code ?? err.message) : String(err);
      this.health.recordFallback('transport_error', msg);
      return this.fallback.score(event);
    }
  }
}

/** Propagate the correlation id when there is one (absent in cron/boot paths). */
function correlationHeaders(): Record<string, string> {
  const id = currentCorrelationId();
  return id ? { [CORRELATION_HEADER]: id } : {};
}
