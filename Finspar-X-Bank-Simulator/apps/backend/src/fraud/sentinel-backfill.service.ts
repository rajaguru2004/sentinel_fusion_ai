import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SentinelIngest } from './sentinel-ingest';
import type { UnifiedEvent } from './scorer.interface';
import { env } from '../common/env';

/**
 * Replays the customer's EXISTING payment history into the model's feature store
 * at boot (`POST /ingest`, chronological, idempotent by event_id).
 *
 * Why this exists: the seeded history lives only in Postgres. The model keeps its
 * own per-user state (sequence depth, amount mean/σ, payee set, hour-of-day,
 * countries) and it is built purely from events it has been sent. With an empty
 * store EVERY payment is the customer's first — `f_user_seq_no` ~0 ("customer has
 * little prior history"), no known payees, no amount baseline — so a routine
 * ₹25,000 supplier transfer scores like a takeover and the LOW demo cannot be
 * demonstrated at all. Backfilling makes normal look normal, which is what makes
 * the abnormal case meaningful.
 *
 * The in-memory store (no SENTINEL_REDIS_URL) is wiped whenever the model
 * restarts, hence "every boot" rather than a one-shot script. Re-sending is safe:
 * the store dedups on event_id.
 *
 * Off the money path entirely — runs after bootstrap, swallows its own failures.
 */
@Injectable()
export class SentinelBackfill implements OnApplicationBootstrap {
  private readonly log = new Logger(SentinelBackfill.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: SentinelIngest,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!env.sentinel.enabled || !env.sentinel.backfillOnBoot) return;
    // Deliberately not awaited by the bootstrap path — the API must accept
    // traffic immediately; a slow model must not delay or fail the boot.
    void this.run().catch((e: unknown) => this.log.warn(`History backfill aborted: ${String(e)}`));
  }

  /** Public so it can be re-run manually (npm run demo:warm-history). */
  async run(): Promise<{ sent: number; skipped: number }> {
    const t0 = Date.now();
    const events = await this.buildHistory();
    let sent = 0;
    let skipped = 0;
    // Sequential: the store folds events into per-user state in arrival order,
    // so a parallel burst would compute velocity and "is this payee known?"
    // against a half-built history.
    for (const event of events) {
      if (await this.ingest.streamOrdered(event)) sent += 1;
      else skipped += 1;
    }
    this.log.log(
      `History backfill: ${sent} events ingested${skipped ? `, ${skipped} failed` : ''} in ${Date.now() - t0}ms`,
    );
    return { sent, skipped };
  }

  /**
   * Beneficiary activations + settled payments, oldest first, with the values as
   * they were AT THAT TIME (running mean, prior-hour count, payee age) rather
   * than today's — a backfill that stamped current numbers on old events would
   * teach the model a history that never happened.
   */
  private async buildHistory(): Promise<UnifiedEvent[]> {
    const [users, customers, beneficiaries, payments] = await Promise.all([
      this.prisma.user.findMany(),
      this.prisma.customer.findMany(),
      this.prisma.beneficiary.findMany(),
      this.prisma.payment.findMany({
        // Settled money only. Drafts (NEW) and rejected attempts are not
        // "normal behaviour" and would inflate the velocity baseline.
        where: { status: { in: [PaymentStatus.COMPLETED, PaymentStatus.PROCESSING] } },
        orderBy: { createdAt: 'asc' },
        take: 2000,
      }),
    ]);

    const userByUserId = new Map(users.map((u) => [u.userId, u]));
    const customerById = new Map(customers.map((c) => [c.id, c]));
    const beneById = new Map(beneficiaries.map((b) => [b.id, b]));

    const events: UnifiedEvent[] = [];

    // Payee activations first, so the payee already exists (and has an age) by
    // the time the payments referencing it are folded in.
    for (const b of beneficiaries) {
      if (!b.activatedAt) continue;
      const actor = b.activatedBy ? userByUserId.get(b.activatedBy) : undefined;
      if (!actor) continue;
      events.push({
        eventId: `hist-ben:${b.id}`,
        eventType: 'BENEFICIARY_ACTIVATE',
        userId: actor.id,
        // Deliberately NO beneficiaryId: the store's payee set answers "has this
        // customer PAID this account before". Registering a payee is not paying
        // one, and marking it seen here would silence "first ever payment to this
        // beneficiary" on the very first transfer — the signal the cooling-period
        // rule exists to catch.
        timestamp: b.activatedAt.toISOString(),
        isNewBeneficiary: true,
        beneficiaryAgeMinutes: 0,
        channel: 'web',
        country: 'IN',
      });
    }

    // Running per-user stats, advanced in event order — the same quantities the
    // gateway computes live in buildPaymentEvent().
    const seen = new Map<string, { count: number; sum: number; times: number[] }>();

    for (const p of payments) {
      const actor = p.initiatedBy ? userByUserId.get(p.initiatedBy) : undefined;
      const bene = beneById.get(p.beneficiaryId);
      if (!actor) continue;
      const customer = customerById.get(p.customerId);
      const amountRupees = Number(p.amount) / 100;
      const at = p.createdAt.getTime();

      const stats = seen.get(actor.id) ?? { count: 0, sum: 0, times: [] };
      const meanBefore = stats.count > 0 ? stats.sum / stats.count : amountRupees;
      const txnCountLastHour = stats.times.filter((t) => t >= at - 3_600_000).length;

      const ageMinutes = bene?.activatedAt
        ? Math.max(0, (at - bene.activatedAt.getTime()) / 60_000)
        : undefined;

      events.push({
        // `hist:` namespace, NOT `pay:` — a real confirm of the same payment must
        // still be scoreable rather than deduped against the backfill.
        eventId: `hist:${p.id}`,
        eventType: 'PAYMENT_INITIATE',
        userId: actor.id,
        paymentId: p.id,
        timestamp: p.createdAt.toISOString(),
        amount: amountRupees,
        rail: p.rail,
        beneficiaryId: p.beneficiaryId,
        beneficiaryAgeMinutes: ageMinutes,
        isNewBeneficiary: ageMinutes != null && ageMinutes < 60,
        txnCountLastHour,
        amountVsUserMean: meanBefore > 0 ? amountRupees / meanBefore : 1,
        nameMismatch:
          !!bene?.nameAsFetched && bene.name.toLowerCase() !== bene.nameAsFetched.toLowerCase(),
        customerAge: customer?.customerAge ?? undefined,
        income: customer?.incomeBand ?? undefined,
        accountAgeSeconds: customer ? Math.max(0, (at - customer.createdAt.getTime()) / 1000) : undefined,
        channel: 'web',
        country: 'IN',
      });

      stats.count += 1;
      stats.sum += amountRupees;
      stats.times.push(at);
      seen.set(actor.id, stats);
    }

    return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}
