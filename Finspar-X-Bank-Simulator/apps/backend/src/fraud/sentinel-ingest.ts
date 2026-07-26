import { Injectable, Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import { Agent as HttpAgent } from 'node:http';
import { env } from '../common/env';
import type { UnifiedEvent } from './scorer.interface';
import { toEventIn } from './sentinel-adapter';

/**
 * Fire-and-forget client for the model's `POST /ingest` (schema §3.1). Context
 * events — beneficiary add/activate, balance/statement views — build a user's
 * history and velocity in the feature store WITHOUT a scoring verdict, so the
 * next payment /score returns full-fidelity features instead of `degraded`.
 *
 * Guardrail: NEVER on the request's critical path. `stream()` returns void and
 * swallows every error; callers must not await it for correctness.
 */
@Injectable()
export class SentinelIngest {
  private readonly log = new Logger(SentinelIngest.name);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: env.sentinel.url,
      timeout: env.sentinel.timeoutMs,
      httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 16 }),
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.sentinel.apiKey,
      },
    });
  }

  /**
   * Awaited single ingest, for callers that must control ORDER — the store
   * advances per-user state in arrival order, so a history backfill has to post
   * chronologically rather than fire a burst. Returns false instead of throwing;
   * still never belongs on a request path.
   */
  async streamOrdered(event: UnifiedEvent): Promise<boolean> {
    if (!env.sentinel.enabled) return false;
    try {
      await this.http.post('/ingest', toEventIn(event));
      return true;
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? (err.code ?? err.message) : String(err);
      this.log.warn(`Sentinel /ingest failed for ${event.eventId ?? event.eventType}: ${msg}`);
      return false;
    }
  }

  /** Stream one context event. No-op when the model is disabled. Never throws. */
  stream(event: UnifiedEvent): void {
    if (!env.sentinel.enabled) return;
    this.http
      .post('/ingest', toEventIn(event))
      .then((res) => {
        console.log(
          `[Sentinel /ingest] ${event.eventType} (${event.eventId ?? 'no-id'}) ` +
            `country=${event.country ?? 'unknown'} -> ${JSON.stringify(res.data)}`,
        );
      })
      .catch((err: unknown) => {
        const msg = axios.isAxiosError(err) ? (err.code ?? err.message) : String(err);
        this.log.warn(`Sentinel /ingest failed for ${event.eventId ?? event.eventType}: ${msg}`);
      });
  }
}
