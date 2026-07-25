import { Injectable, Inject } from '@nestjs/common';
import { RiskLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SCORER, type Scorer, type UnifiedEvent, type RiskVerdict } from './scorer.interface';
import { resolveGeo } from './geoip';

export type Decision = 'EXECUTE' | 'CHALLENGE' | 'HOLD' | 'BLOCK';

export interface Assessment extends RiskVerdict {
  decision: Decision;
}

interface RequestContext {
  ip?: string;
  userAgent?: string;
  deviceFingerprint?: string;
  sessionId?: string;
  mockCountry?: string; // dev mock-VPN override (X-Mock-Country header)
}

/**
 * Every state-changing money operation routes through here before the ledger is
 * touched (§9). Phase 1 wires a heuristic scorer behind the Scorer interface;
 * phase 2 swaps in HttpScorer -> FastAPI with no call-site changes.
 */
@Injectable()
export class FraudGateway {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SCORER) private readonly scorer: Scorer,
  ) {}

  private decide(level: RiskLevel): Decision {
    switch (level) {
      case RiskLevel.LOW:
        return 'EXECUTE';
      case RiskLevel.MEDIUM:
        return 'CHALLENGE';
      case RiskLevel.HIGH:
        return 'HOLD';
      case RiskLevel.CRITICAL:
        return 'BLOCK';
    }
  }

  /** Score a built event, persist a FraudEvent, return verdict + decision. */
  async assess(
    event: UnifiedEvent,
    ctx: { userId?: string; paymentId?: string; ip?: string; deviceFingerprint?: string },
  ): Promise<Assessment> {
    const verdict = await this.scorer.score(event);
    const decision = this.decide(verdict.riskLevel);

    await this.prisma.fraudEvent.create({
      data: {
        eventId: event.eventId,
        paymentId: ctx.paymentId,
        userId: ctx.userId,
        eventType: event.eventType,
        riskScore: verdict.riskScore,
        riskLevel: verdict.riskLevel,
        modelScores: verdict.modelScores ?? undefined,
        shapReasons: verdict.reasons,
        decision,
        ip: ctx.ip,
        deviceFingerprint: ctx.deviceFingerprint,
      },
    });

    return { ...verdict, decision };
  }

  /** Build a LOGIN UnifiedEvent (routes to the behaviour model). */
  buildLoginEvent(params: {
    userId: string;
    loginEventId: string;
    ctx: RequestContext;
  }): UnifiedEvent {
    const geo = resolveGeo(params.ctx.ip, params.ctx.mockCountry);
    return {
      eventId: `login:${params.loginEventId}`,
      eventType: 'LOGIN',
      userId: params.userId,
      ip: params.ctx.ip,
      deviceFingerprint: params.ctx.deviceFingerprint,
      userAgent: params.ctx.userAgent,
      sessionId: params.ctx.sessionId,
      timestamp: new Date().toISOString(),
      country: geo.country,
      geoLat: geo.lat,
      geoLon: geo.lon,
    };
  }

  /** Build a payment UnifiedEvent, pulling velocity / beneficiary-age / mean +
   *  balances / customer profile (Step 8) from the DB. */
  async buildPaymentEvent(params: {
    userId: string;
    customerId: string;
    paymentId?: string;
    debitAccountId?: string;
    amountPaise: bigint;
    rail: string;
    beneficiaryId: string;
    nameMismatch?: boolean;
    ctx: RequestContext;
    eventType?: 'PAYMENT_INITIATE' | 'PAYMENT_MODIFY';
  }): Promise<UnifiedEvent> {
    const amountRupees = Number(params.amountPaise) / 100;

    const [beneficiary, txnCountLastHour, agg, debitAccount, customer, user] = await Promise.all([
      this.prisma.beneficiary.findUnique({ where: { id: params.beneficiaryId } }),
      this.prisma.payment.count({
        where: { customerId: params.customerId, createdAt: { gte: new Date(Date.now() - 3600_000) } },
      }),
      this.prisma.payment.aggregate({
        where: { customerId: params.customerId, status: 'COMPLETED' },
        _avg: { amount: true },
      }),
      params.debitAccountId
        ? this.prisma.account.findUnique({ where: { id: params.debitAccountId } })
        : Promise.resolve(null),
      this.prisma.customer.findUnique({ where: { id: params.customerId } }),
      this.prisma.user.findUnique({ where: { id: params.userId } }),
    ]);

    const meanRupees = agg._avg.amount ? Number(agg._avg.amount) / 100 : amountRupees;
    const beneficiaryAgeMinutes = beneficiary?.activatedAt
      ? (Date.now() - beneficiary.activatedAt.getTime()) / 60000
      : undefined;

    // Payer balances (rupees). Debit lowers the balance.
    const balanceBefore = debitAccount ? Number(debitAccount.clearBalance) / 100 : undefined;
    const balanceAfter = balanceBefore != null ? balanceBefore - amountRupees : undefined;

    // Counterparty balances — only own-bank beneficiaries have an internal account.
    let counterpartyBalanceBefore: number | undefined;
    let counterpartyBalanceAfter: number | undefined;
    if (beneficiary?.isOwnBank && beneficiary.accountNumber) {
      const cpAccount = await this.prisma.account.findUnique({
        where: { accountNumber: beneficiary.accountNumber },
      });
      if (cpAccount) {
        counterpartyBalanceBefore = Number(cpAccount.clearBalance) / 100;
        counterpartyBalanceAfter = counterpartyBalanceBefore + amountRupees; // credit
      }
    }

    const accountAgeSeconds = customer ? (Date.now() - customer.createdAt.getTime()) / 1000 : undefined;
    const geo = resolveGeo(params.ctx.ip, params.ctx.mockCountry);

    const eventType = params.eventType ?? 'PAYMENT_INITIATE';
    // Stable idempotency key, reused on retries so the model's velocity counters
    // advance once. Namespaced so a re-score on the edit path (mod:) is a
    // distinct logical event from the initial confirm (pay:).
    const idPrefix = eventType === 'PAYMENT_MODIFY' ? 'mod' : 'pay';

    return {
      eventId: params.paymentId ? `${idPrefix}:${params.paymentId}` : undefined,
      eventType,
      userId: params.userId,
      paymentId: params.paymentId,
      ip: params.ctx.ip,
      deviceFingerprint: params.ctx.deviceFingerprint,
      userAgent: params.ctx.userAgent,
      sessionId: params.ctx.sessionId,
      timestamp: new Date().toISOString(),
      amount: amountRupees,
      rail: params.rail,
      beneficiaryAgeMinutes,
      isNewBeneficiary: beneficiaryAgeMinutes != null && beneficiaryAgeMinutes < 60,
      txnCountLastHour,
      amountVsUserMean: meanRupees > 0 ? amountRupees / meanRupees : 1,
      nameMismatch: params.nameMismatch,
      balanceBefore,
      balanceAfter,
      counterpartyBalanceBefore,
      counterpartyBalanceAfter,
      customerAge: customer?.customerAge ?? undefined,
      income: customer?.incomeBand ?? undefined,
      accountAgeSeconds,
      emailIsFree: user ? isFreeEmail(user.email) : undefined,
      channel: 'web',
      country: geo.country,
      geoLat: geo.lat,
      geoLon: geo.lon,
    };
  }
}

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'yahoo.in',
  'outlook.com',
  'hotmail.com',
  'rediffmail.com',
  'icloud.com',
]);

/** Free webmail domains score differently from corporate/bank domains (§8). */
function isFreeEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? FREE_EMAIL_DOMAINS.has(domain) : false;
}
