import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import axios from 'axios';
import { Agent as HttpAgent } from 'node:http';
import { env } from '../common/env';

/**
 * Warms the model's SHAP explainer at boot. The first `/score?explain=true` call
 * has to build the LightGBM TreeExplainer, which takes several seconds cold and
 * would otherwise blow the request timeout on a real user's first payment and
 * fail open. Firing one throwaway explained score on startup moves that cost off
 * the money path. Best-effort and non-fatal — the app boots regardless.
 */
@Injectable()
export class SentinelWarmup implements OnApplicationBootstrap {
  private readonly log = new Logger(SentinelWarmup.name);

  async onApplicationBootstrap(): Promise<void> {
    if (!env.sentinel.enabled) return;
    const http = axios.create({
      baseURL: env.sentinel.url,
      timeout: Math.max(env.sentinel.timeoutMs, 15000), // cold SHAP can be slow
      httpAgent: new HttpAgent({ keepAlive: true }),
      headers: { 'Content-Type': 'application/json', 'X-API-Key': env.sentinel.apiKey },
    });
    const probe = {
      event_id: `warmup:${Date.now()}`,
      event_domain: 'financial',
      event_time: new Date().toISOString(),
      user_id: 'warmup',
      event_type: 'PAYMENT_INITIATE',
      amount: 1000,
      currency: 'INR',
      payment_type: 'transfer',
      is_credit: 0,
    };
    const t0 = Date.now();
    try {
      await http.post('/score?explain=true', probe);
      this.log.log(`Sentinel SHAP explainer warmed in ${Date.now() - t0}ms`);
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.code ?? err.message) : String(err);
      this.log.warn(`Sentinel warmup skipped (${msg}) — first real score may be slow`);
    }
  }
}
