import { Injectable, Logger } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import { currentCorrelationId } from '../common/correlation';

/** A verdict, the instant it is produced. Mirrors the analyst feed row shape. */
export interface LiveAlert {
  id: string;
  at: string;
  correlationId?: string;
  eventType: string;
  riskScore: number;
  riskLevel: string;
  decision: string;
  reasons: string[];
  userId?: string;
  paymentId?: string;
  /** Present for payment events so the console can show what was at stake. */
  amount?: string;
  refNo?: string;
}

/**
 * In-process pub/sub behind the analyst console's live stream (§6).
 *
 * `FraudGateway.assess()` publishes here on every scored event; the controller
 * turns the stream into SSE. Deliberately an RxJS Subject rather than a queue or
 * Redis channel: subscribers are browser tabs attached to *this* instance, and a
 * missed alert is not a correctness problem — the console loads the persisted
 * `FraudEvent` feed on mount and the stream only carries what happens after.
 * If this ever runs multi-instance, the Subject becomes a Redis pub/sub
 * subscription and nothing else changes.
 */
@Injectable()
export class LiveAlertsService {
  private readonly log = new Logger(LiveAlertsService.name);
  private readonly subject = new Subject<LiveAlert>();
  private subscribers = 0;

  publish(alert: Omit<LiveAlert, 'at' | 'correlationId'>): void {
    // Never let a console subscriber's failure propagate back into the money
    // path that produced the event.
    try {
      this.subject.next({
        ...alert,
        at: new Date().toISOString(),
        correlationId: currentCorrelationId(),
      });
    } catch (e) {
      this.log.warn(`Failed to publish live alert: ${String(e)}`);
    }
  }

  stream(): Observable<LiveAlert> {
    return this.subject.asObservable();
  }

  trackSubscriber(delta: 1 | -1): number {
    this.subscribers += delta;
    return this.subscribers;
  }
}
