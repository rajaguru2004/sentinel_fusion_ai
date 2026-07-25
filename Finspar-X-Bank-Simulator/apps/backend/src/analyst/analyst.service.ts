import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { SentinelFeedback } from '../fraud/sentinel-feedback';
import type { JwtPayload } from '../auth/jwt.strategy';

/** Analyst dashboard data (§14). Reads whatever the scorer wrote to FraudEvent. */
@Injectable()
export class AnalystService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly feedback: SentinelFeedback,
  ) {}

  /** Only an AUTHORIZER may release/reject a held payment (separation of duties). */
  private assertAuthorizer(user: JwtPayload): void {
    if (user.role !== 'AUTHORIZER') {
      throw new ForbiddenException('Only an authorizer can release or reject held payments');
    }
  }

  private async ownedHeld(user: JwtPayload, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, customerId: user.customerId },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== PaymentStatus.HELD) {
      throw new BadRequestException('Payment is not on hold');
    }
    return payment;
  }

  /**
   * All payments currently on hold — the authorizer's actionable review queue.
   * Unlike the event feed (which is flooded by logins/re-scores), this lists the
   * live HELD payments regardless of how old their fraud event is.
   */
  async heldPayments(user: JwtPayload) {
    const held = await this.prisma.payment.findMany({
      where: { customerId: user.customerId, status: PaymentStatus.HELD },
      orderBy: { createdAt: 'desc' },
      include: { beneficiary: { select: { name: true } } },
    });
    return held.map((p) => ({
      paymentId: p.id,
      refNo: p.refNo,
      amount: p.amount,
      rail: p.rail,
      riskLevel: p.riskLevel,
      reasons: p.riskReasons ?? [],
      beneficiaryName: p.beneficiary?.name ?? null,
      createdAt: p.createdAt,
    }));
  }

  /**
   * Release a held payment after review — returns the reserved funds, resets it
   * to NEW, and marks it `reviewApproved` so re-authorising skips the fraud
   * gateway (it won't be re-held). The original risk verdict is kept for audit.
   * Either the maker or an authorizer can then authorise & send it. Authorizer only.
   */
  async release(user: JwtPayload, paymentId: string) {
    this.assertAuthorizer(user);
    await this.ownedHeld(user, paymentId);
    await this.ledger.releaseHold(paymentId, PaymentStatus.NEW);
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { reviewApproved: true },
    });
    return { paymentId, status: PaymentStatus.NEW, message: 'Payment approved — ready to authorise & send' };
  }

  /**
   * Reject a held payment — the analyst deems it fraudulent. Returns the reserved
   * funds, cancels the payment (REJECTED), and confirms the outcome to the model
   * (feedback label=1). Authorizer only.
   */
  async reject(user: JwtPayload, paymentId: string) {
    this.assertAuthorizer(user);
    await this.ownedHeld(user, paymentId);
    await this.ledger.releaseHold(paymentId, PaymentStatus.REJECTED);
    await this.feedback.feedbackForPayment(paymentId, 1);
    return { paymentId, status: PaymentStatus.REJECTED, message: 'Payment rejected as fraudulent' };
  }

  async stats() {
    const byLevel = await this.prisma.fraudEvent.groupBy({
      by: ['riskLevel'],
      _count: true,
    });
    const [totalEvents, openCases, held, blocked] = await Promise.all([
      this.prisma.fraudEvent.count(),
      this.prisma.case.count({ where: { status: 'OPEN' } }),
      this.prisma.payment.aggregate({ where: { status: 'HELD' }, _sum: { amount: true }, _count: true }),
      this.prisma.payment.aggregate({ where: { status: 'BLOCKED' }, _sum: { amount: true }, _count: true }),
    ]);
    const counts: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    for (const g of byLevel) counts[g.riskLevel] = g._count;
    return {
      totalEvents,
      openCases,
      byLevel: counts,
      heldCount: held._count,
      heldAmount: held._sum.amount ?? 0n,
      blockedCount: blocked._count,
      blockedAmount: blocked._sum.amount ?? 0n,
    };
  }

  async feed(limit = 30) {
    const events = await this.prisma.fraudEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        payment: {
          select: { id: true, status: true, refNo: true, amount: true, rail: true, beneficiary: { select: { name: true } } },
        },
      },
    });
    return events.map((e) => ({
      id: e.id,
      createdAt: e.createdAt,
      eventType: e.eventType,
      riskScore: e.riskScore,
      riskLevel: e.riskLevel,
      decision: e.decision,
      reasons: e.shapReasons ?? [],
      paymentId: e.payment?.id ?? null,
      paymentStatus: e.payment?.status ?? null,
      refNo: e.payment?.refNo ?? null,
      amount: e.payment?.amount ?? null,
      rail: e.payment?.rail ?? null,
      beneficiaryName: e.payment?.beneficiary?.name ?? null,
    }));
  }

  /**
   * Case correlation (ENHANCEMENTS.md §6).
   *
   * Given one fraud event, find the others that share an entity with it — same
   * user, same device fingerprint, or same IP — inside a time window, and report
   * WHICH link matched. That last part is the point: "3 related events" is a
   * number, whereas "same device as 2 events, same IP as 1" is an investigation.
   *
   * Everything here comes from columns FraudEvent already stores; no new
   * persistence, and the shape generalises directly to an entity graph.
   */
  async relatedEvents(eventId: string, windowHours = 24) {
    const anchor = await this.prisma.fraudEvent.findUnique({ where: { id: eventId } });
    if (!anchor) throw new NotFoundException('Event not found');

    // Clamp: this is an indexed-but-unbounded scan, and the window is caller-supplied.
    const hours = Math.min(Math.max(windowHours, 1), 24 * 30);
    const since = new Date(anchor.createdAt.getTime() - hours * 3_600_000);
    const until = new Date(anchor.createdAt.getTime() + hours * 3_600_000);

    // Only match on entities the anchor actually has — otherwise a null device
    // fingerprint would "match" every other event that is also missing one.
    const links: { userId?: string; deviceFingerprint?: string; ip?: string }[] = [];
    if (anchor.userId) links.push({ userId: anchor.userId });
    if (anchor.deviceFingerprint) links.push({ deviceFingerprint: anchor.deviceFingerprint });
    if (anchor.ip) links.push({ ip: anchor.ip });

    if (!links.length) {
      return { anchor: this.correlationRow(anchor), windowHours: hours, related: [], summary: emptySummary() };
    }

    const related = await this.prisma.fraudEvent.findMany({
      where: {
        id: { not: anchor.id },
        createdAt: { gte: since, lte: until },
        OR: links,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { payment: { select: { refNo: true, amount: true, status: true } } },
    });

    const summary = emptySummary();
    const rows = related.map((e) => {
      const sharedBy: string[] = [];
      if (anchor.userId && e.userId === anchor.userId) {
        sharedBy.push('user');
        summary.user++;
      }
      if (anchor.deviceFingerprint && e.deviceFingerprint === anchor.deviceFingerprint) {
        sharedBy.push('device');
        summary.device++;
      }
      if (anchor.ip && e.ip === anchor.ip) {
        sharedBy.push('ip');
        summary.ip++;
      }
      return {
        ...this.correlationRow(e),
        sharedBy,
        refNo: e.payment?.refNo ?? null,
        amount: e.payment?.amount ?? null,
        paymentStatus: e.payment?.status ?? null,
      };
    });

    return { anchor: this.correlationRow(anchor), windowHours: hours, related: rows, summary };
  }

  /** Shared projection so the anchor and its neighbours render identically. */
  private correlationRow(e: {
    id: string;
    createdAt: Date;
    eventType: string;
    riskScore: number;
    riskLevel: string;
    decision: string;
    userId: string | null;
    ip: string | null;
    deviceFingerprint: string | null;
  }) {
    return {
      id: e.id,
      createdAt: e.createdAt,
      eventType: e.eventType,
      riskScore: e.riskScore,
      riskLevel: e.riskLevel,
      decision: e.decision,
      userId: e.userId,
      // Never ship a raw fingerprint/IP to the browser in full — enough to
      // recognise a repeat, not enough to be a fresh identifier if the console
      // response leaks.
      ip: e.ip ? maskIp(e.ip) : null,
      deviceFingerprint: e.deviceFingerprint ? `${e.deviceFingerprint.slice(0, 8)}…` : null,
    };
  }

  async cases() {
    const cases = await this.prisma.case.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return cases.map((c) => ({
      trackingRef: c.trackingRef,
      source: c.source,
      fraudType: c.fraudType,
      amount: c.amount,
      status: c.status,
      createdAt: c.createdAt,
    }));
  }
}

function emptySummary(): { user: number; device: number; ip: number } {
  return { user: 0, device: 0, ip: 0 };
}

/** IPv4 -> 203.0.113.x, IPv6 -> first three groups. Enough to compare, not to reuse. */
function maskIp(ip: string): string {
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::…`;
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.x` : ip;
}
