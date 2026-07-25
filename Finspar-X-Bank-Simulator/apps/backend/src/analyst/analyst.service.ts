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
