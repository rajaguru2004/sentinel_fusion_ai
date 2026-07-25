import { Injectable, Logger } from '@nestjs/common';
import { logTag } from '../common/correlation';

/** Why the model did not produce the verdict for a given event. */
export type FallbackReason = 'transport_error' | 'unscored' | 'disabled';

export interface ScoringHealth {
  /** True while recent traffic has been falling back to the heuristic. */
  degraded: boolean;
  /** Fraction of the recent window that fell back (0–1). */
  fallbackRate: number;
  /** Size of the window the rate is computed over. */
  windowSize: number;
  totals: { scored: number; fellBack: number; storeUnavailable: number };
  lastFallback: { at: string; reason: FallbackReason; detail: string } | null;
  lastSuccess: string | null;
}

/** Rolling window of recent scoring outcomes. Small enough to react quickly. */
const WINDOW = 50;
/** Fallback fraction of the window above which we declare "degraded". */
const DEGRADED_AT = 0.2;

/**
 * Makes fail-open observable (ENHANCEMENTS.md §3).
 *
 * `HttpScorer` correctly falls back to the heuristic whenever Sentinel errors —
 * a model outage must never hang the money path. The problem was that it did so
 * *silently*: fraud scoring could run on rules for hours and nothing said so.
 *
 * This is the counter behind that. It is deliberately in-process and unbounded
 * by time rather than a real metrics pipeline: the goal is a truthful signal the
 * analyst console can render and an operator can alert on, without adding a
 * Prometheus dependency to a demo stack. Swap `record*` for a metrics client
 * when there is one.
 */
@Injectable()
export class ScorerHealthService {
  private readonly log = new Logger('ScorerHealth');

  /** true = fell back, false = model scored it. Capped at WINDOW entries. */
  private readonly window: boolean[] = [];
  private scored = 0;
  private fellBack = 0;
  private storeUnavailable = 0;
  private lastFallback: ScoringHealth['lastFallback'] = null;
  private lastSuccess: string | null = null;
  /** Latches so the transition into/out of degraded logs once, not per request. */
  private wasDegraded = false;

  recordSuccess(): void {
    this.scored++;
    this.lastSuccess = new Date().toISOString();
    this.push(false);
  }

  recordFallback(reason: FallbackReason, detail: string): void {
    this.fellBack++;
    this.lastFallback = { at: new Date().toISOString(), reason, detail };
    this.push(true);
    // Per-event line so a single blip is still traceable to its request...
    this.log.warn(`${logTag()}fail-open -> heuristic (${reason}: ${detail})`);
  }

  /** The model scored, but without its feature store — verdict is weaker. */
  recordStoreUnavailable(eventId: string): void {
    this.storeUnavailable++;
    this.log.warn(`${logTag()}scored ${eventId} with feature store unavailable — degraded verdict`);
  }

  private push(fellBack: boolean): void {
    this.window.push(fellBack);
    if (this.window.length > WINDOW) this.window.shift();

    // ...and one ALERT line on the edge, which is what an operator greps for.
    const degraded = this.isDegraded();
    if (degraded && !this.wasDegraded) {
      this.log.error(
        `ALERT fraud scoring DEGRADED — ${Math.round(this.rate() * 100)}% of the last ` +
          `${this.window.length} events fell back to the heuristic. Verdicts are rule-based.`,
      );
    } else if (!degraded && this.wasDegraded) {
      this.log.log('fraud scoring RECOVERED — model verdicts are flowing again');
    }
    this.wasDegraded = degraded;
  }

  private rate(): number {
    if (!this.window.length) return 0;
    return this.window.filter(Boolean).length / this.window.length;
  }

  private isDegraded(): boolean {
    // Require a few samples so one failure on a quiet system is not "degraded".
    if (this.window.length < 5) return this.window.every(Boolean) && this.window.length > 0;
    return this.rate() >= DEGRADED_AT;
  }

  snapshot(): ScoringHealth {
    return {
      degraded: this.isDegraded(),
      fallbackRate: Number(this.rate().toFixed(3)),
      windowSize: this.window.length,
      totals: { scored: this.scored, fellBack: this.fellBack, storeUnavailable: this.storeUnavailable },
      lastFallback: this.lastFallback,
      lastSuccess: this.lastSuccess,
    };
  }
}
