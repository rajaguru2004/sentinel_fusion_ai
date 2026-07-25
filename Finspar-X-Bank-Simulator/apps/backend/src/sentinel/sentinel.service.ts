import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import { Agent as HttpAgent } from 'node:http';
import { env } from '../common/env';

/**
 * Thin pass-through to the Sentinel Fusion AI model, so the BROWSER can reach it.
 *
 * Why this exists: the FastAPI service mounts no CORS middleware (there is no
 * `add_middleware(CORSMiddleware, ...)` anywhere in `sentinel_fusion_ai/service`),
 * so a `fetch('http://localhost:8000/score')` from the Next.js app is blocked by
 * the browser before it ever leaves. It also means the model's API key would have
 * to be shipped to the client. Proxying through the bank keeps the key server-side
 * and gives the console one same-origin endpoint.
 *
 * This deliberately does NOT go through FraudGateway: the Sentinel Console is an
 * inspection tool, not a money path. Nothing here writes a FraudEvent, touches the
 * ledger, or pollutes the analyst feed.
 */
@Injectable()
export class SentinelService {
  private readonly log = new Logger(SentinelService.name);
  private readonly http: AxiosInstance;

  /** Domains the console is allowed to submit. `threat_intel` is accepted so the
   *  Command Center can demonstrate an unscored (`scored:false`) response. */
  static readonly DOMAINS = ['financial', 'behaviour', 'cyber', 'quantum', 'threat_intel'];

  constructor() {
    this.http = axios.create({
      baseURL: env.sentinel.url,
      // Deliberately far above SENTINEL_TIMEOUT_MS (default 800ms). That budget
      // exists because the money path must never hang; the console has no such
      // constraint, and the first ?explain=true call builds the SHAP TreeExplainer
      // and can take ~6s. Timing out here would show the judges a spurious error.
      timeout: 30_000,
      httpAgent: new HttpAgent({ keepAlive: true }),
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.sentinel.apiKey,
      },
    });
  }

  private assertEnabled(): void {
    if (!env.sentinel.enabled) {
      throw new HttpException(
        {
          message:
            'Sentinel is disabled (SENTINEL_ENABLED is not "true"), so the console has no model to talk to.',
          fix: 'Start the model and export SENTINEL_ENABLED=true SENTINEL_URL=http://127.0.0.1:8000 before starting the backend.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Forward one event to `POST /score?explain=true`.
   *
   * The model's `EventIn` is `extra="forbid"`, so we pass the body through
   * unaltered and surface its 422 verbatim — that message names the offending
   * field, which is exactly what someone editing the console form needs to see.
   */
  async score(event: Record<string, unknown>): Promise<unknown> {
    this.assertEnabled();

    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new HttpException('Body must be a single event object', HttpStatus.BAD_REQUEST);
    }
    const domain = event.event_domain;
    if (typeof domain !== 'string' || !SentinelService.DOMAINS.includes(domain)) {
      throw new HttpException(
        `event_domain must be one of: ${SentinelService.DOMAINS.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (JSON.stringify(event).length > 16_384) {
      throw new HttpException('Event too large', HttpStatus.PAYLOAD_TOO_LARGE);
    }

    // The model rejects a naive timestamp and anything >300s in the future
    // (reject_future_events_seconds). Default to now so the console never trips it.
    const body = {
      event_time: new Date().toISOString(),
      ...event,
    };

    try {
      const { data } = await this.http.post('/score?explain=true', body);
      return data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        // Pass the model's own error through — 422 bodies name the bad field.
        throw new HttpException(err.response.data ?? err.message, err.response.status);
      }
      const msg = axios.isAxiosError(err) ? (err.code ?? err.message) : String(err);
      this.log.error(`Sentinel /score proxy failed: ${msg}`);
      throw new HttpException(
        {
          message: `Could not reach the Sentinel model at ${env.sentinel.url} (${msg}).`,
          fix: 'Check the model is up (curl http://localhost:8000/ready). On a host-run backend SENTINEL_URL must be http://127.0.0.1:8000 — "localhost" resolves to IPv6 and times out.',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /** Proxy `/ready` for the console health strip. */
  async ready(): Promise<unknown> {
    this.assertEnabled();
    try {
      const { data } = await this.http.get('/ready', { timeout: 5_000 });
      return data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) return err.response.data;
      throw new HttpException(
        `Sentinel unreachable at ${env.sentinel.url}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Parse the model's Prometheus text into scoreboard rows.
   *
   * `/metrics` is unauthenticated (no `require_api_key` on that router), and
   * `sentinel_scored_total{model,risk_level}` is the most honest evidence on
   * screen that the models are actually being called — it is incremented inside
   * the scoring path itself, so it cannot be faked by the UI.
   */
  async metrics(): Promise<{
    rows: { model: string; riskLevel: string; count: number }[];
    total: number;
  }> {
    this.assertEnabled();
    let text: string;
    try {
      const res = await this.http.get<string>('/metrics', {
        timeout: 5_000,
        responseType: 'text',
        transformResponse: [(d: string) => d],
      });
      text = res.data;
    } catch {
      return { rows: [], total: 0 };
    }

    const rows: { model: string; riskLevel: string; count: number }[] = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('sentinel_scored_total{')) continue;
      const model = /model="([^"]*)"/.exec(line)?.[1];
      const riskLevel = /risk_level="([^"]*)"/.exec(line)?.[1];
      const count = Number(line.slice(line.lastIndexOf(' ') + 1));
      if (model && riskLevel && Number.isFinite(count)) rows.push({ model, riskLevel, count });
    }
    rows.sort((a, b) => a.model.localeCompare(b.model) || a.riskLevel.localeCompare(b.riskLevel));
    return { rows, total: rows.reduce((n, r) => n + r.count, 0) };
  }
}
