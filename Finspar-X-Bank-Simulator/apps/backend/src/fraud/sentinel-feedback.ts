import { Injectable, Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import { Agent as HttpAgent } from 'node:http';
import { env } from '../common/env';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Feedback client for the model's `POST /feedback` (schema §5.3). The bank posts
 * the adjudicated outcome of an event — a confirmed fraud report, a chargeback,
 * an analyst BLOCK — and the model advances that user's malicious counter,
 * idempotent per `event_id`.
 *
 * We reuse the SAME `event_id` persisted on FraudEvent at score time, so the
 * label lands on exactly the event the model scored. Best-effort and non-fatal:
 * a model outage must never fail the customer-facing dispute flow.
 */
@Injectable()
export class SentinelFeedback {
  private readonly log = new Logger(SentinelFeedback.name);
  private readonly http: AxiosInstance;

  constructor(private readonly prisma: PrismaService) {
    this.http = axios.create({
      baseURL: env.sentinel.url,
      timeout: env.sentinel.timeoutMs,
      httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 8 }),
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.sentinel.apiKey,
      },
    });
  }

  /** Post feedback for one scored event. Never throws. */
  private async send(eventId: string, userId: string, label: 0 | 1): Promise<void> {
    if (!env.sentinel.enabled) return;
    try {
      const { data } = await this.http.post('/feedback', { event_id: eventId, user_id: userId, label });
      console.log(`[Sentinel /feedback] ${eventId} label=${label} -> ${JSON.stringify(data)}`);
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.code ?? err.message) : String(err);
      this.log.warn(`Sentinel /feedback failed for ${eventId}: ${msg}`);
    }
  }

  /**
   * Label every scored FraudEvent for a payment (there may be a `pay:` and a
   * `mod:` event). `confirmedAt` is captured as now — when the bank learned the
   * truth — and surfaces in the training export.
   */
  async feedbackForPayment(paymentId: string, label: 0 | 1): Promise<void> {
    if (!env.sentinel.enabled) return;
    const events = await this.prisma.fraudEvent.findMany({
      where: { paymentId, eventId: { not: null }, userId: { not: null } },
      select: { eventId: true, userId: true },
    });
    await Promise.all(
      events.map((e) => this.send(e.eventId as string, e.userId as string, label)),
    );
  }
}
