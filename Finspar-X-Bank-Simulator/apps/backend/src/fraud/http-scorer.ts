import { Injectable, Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import { Agent as HttpAgent } from 'node:http';
import { env } from '../common/env';
import { HeuristicScorer } from './heuristic-scorer';
import type { Scorer, UnifiedEvent, RiskVerdict } from './scorer.interface';
import { toEventIn, toRiskVerdict, type SentinelScoreOut } from './sentinel-adapter';

/**
 * Phase 2 scorer — routes UnifiedEvents to the Sentinel Fusion AI model
 * (`POST /score`). Implements the same Scorer interface as HeuristicScorer, so
 * swapping it in is a provider change with no call-site impact.
 *
 * Guardrail: FAIL OPEN. Any error, timeout, or an unscored event falls back to
 * the injected HeuristicScorer so the money path never hangs on a model outage.
 */
@Injectable()
export class HttpScorer implements Scorer {
  private readonly log = new Logger(HttpScorer.name);
  private readonly http: AxiosInstance;

  constructor(private readonly fallback: HeuristicScorer) {
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
      );

      // Full model response, for visibility in the backend console.
      console.log(
        `\n[Sentinel /score] ${event.eventType} (${event.eventId ?? 'no-id'}) ` +
          `country=${event.country ?? 'unknown'} ->\n` +
          JSON.stringify(data, null, 2),
      );

      // No model covered the event (e.g. threat_intel) — heuristic decides.
      if (!data.scored) {
        this.log.warn(`Sentinel returned scored=false for ${data.event_id}; using heuristic`);
        return this.fallback.score(event);
      }

      if (data.degradation?.store_unavailable) {
        this.log.warn(`Sentinel scored ${data.event_id} degraded (feature store unavailable)`);
      }
      return toRiskVerdict(data);
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.code ?? err.message) : String(err);
      this.log.error(`Sentinel /score failed (${msg}); failing open to heuristic`);
      return this.fallback.score(event);
    }
  }
}
