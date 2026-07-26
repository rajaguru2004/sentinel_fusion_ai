import { Injectable, Inject } from '@nestjs/common';
import { RiskLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SCORER, type Scorer, type UnifiedEvent, type RiskVerdict } from './scorer.interface';
import { RiskAlertService } from './risk-alert.service';
import { LiveAlertsService } from './live-alerts.service';
import { resolveGeo } from './geoip';
import { env } from '../common/env';
import { SettingsService, atOrAbove } from '../settings/settings.service';

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
    private readonly alerts: RiskAlertService,
    private readonly live: LiveAlertsService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Band -> action, with the BLOCK threshold under operator control (§8.14).
   *
   * The base ladder is unchanged. On top of it, any band at or above the
   * configured `blockMinLevel` escalates to BLOCK, and turning blocking off
   * removes BLOCK from the ladder entirely — a CRITICAL payment then falls back
   * to HOLD, so it is still stopped and still queued for analyst review, just
   * without freezing the customer's account.
   *
   * Defaults (enabled, CRITICAL) reproduce the previous hardcoded switch.
   */
  private async decide(level: RiskLevel): Promise<Decision> {
    const { blockEnabled, blockMinLevel } = await this.settings.get();
    if (blockEnabled && atOrAbove(level, blockMinLevel)) return 'BLOCK';

    switch (level) {
      case RiskLevel.LOW:
        return 'EXECUTE';
      case RiskLevel.MEDIUM:
        return 'CHALLENGE';
      case RiskLevel.HIGH:
      // Blocking is off (or its floor is above CRITICAL): hold rather than
      // block, so the money is still stopped short of the ledger.
      case RiskLevel.CRITICAL:
        return 'HOLD';
    }
  }

  /** Score a built event, persist a FraudEvent, return verdict + decision. */
  async assess(
    event: UnifiedEvent,
    ctx: { userId?: string; paymentId?: string; ip?: string; deviceFingerprint?: string },
  ): Promise<Assessment> {
    const mlVerdict = await this.scorer.score(event);
    // Post-model policy: foreign-country requests are floored to at least
    // MEDIUM risk regardless of the ML score. This is an explicit bank rule,
    // not a model feature — country signal is too weak in the current bundles
    // to move the score on its own (see feature_spec.py:161 and the probe
    // results in tests/specs/02-habits-watcher.spec.ts).
    const verdict = applyCountryPolicy(event, mlVerdict);
    const decision = await this.decide(verdict.riskLevel);

    const persisted = await this.prisma.fraudEvent.create({
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

    // Push to any attached analyst console (§6). Fire-and-forget and internally
    // guarded — a live viewer must never be able to affect the money path.
    this.live.publish({
      id: persisted.id,
      eventType: event.eventType,
      riskScore: verdict.riskScore,
      riskLevel: verdict.riskLevel,
      decision,
      reasons: verdict.reasons,
      userId: ctx.userId,
      paymentId: ctx.paymentId,
      amount: event.amount != null ? String(event.amount) : undefined,
    });

    // One qualifying event -> one mail. Not awaited: SMTP must never sit on the
    // money path, and notify() swallows its own failures.
    this.alerts.notify(event, verdict, decision, ctx);

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
      // Velocity = payments actually PUT THROUGH the gateway in the last hour,
      // not rows created. A draft the user typed and abandoned never moved
      // money and is not an attempt; counting it meant opening the payment form
      // a few times raised the customer's fraud score, which is both wrong and
      // (empirically) the single largest driver of the model's verdict. A
      // payment carries a riskScore only once confirm() has assessed it, and the
      // event being scored right now is still null here, so it never counts
      // itself.
      this.prisma.payment.count({
        where: {
          customerId: params.customerId,
          createdAt: { gte: new Date(Date.now() - 3600_000) },
          riskScore: { not: null },
        },
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
      beneficiaryId: params.beneficiaryId,
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

// ---------------------------------------------------------------- policy ----

/** Risk-level ordering — higher index = higher risk. */
const LEVEL_ORDER: RiskLevel[] = [
  RiskLevel.LOW,
  RiskLevel.MEDIUM,
  RiskLevel.HIGH,
  RiskLevel.CRITICAL,
];

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

/**
 * Gateway policy: floor the verdict to MEDIUM when the event's country is
 * outside the bank's allowed-country list (env.geo.allowedCountries).
 *
 * Only escalates — never downgrades a model HIGH or CRITICAL verdict.
 * Appends a human-readable reason and a `p_country_policy` model-score key
 * so the analyst feed shows why the decision was elevated.
 */
export function applyCountryPolicy(event: UnifiedEvent, verdict: RiskVerdict): RiskVerdict {
  const country = event.country;
  if (!country) return verdict; // no geo info — policy can't fire
  if (env.geo.allowedCountries.has(country)) return verdict; // home market — pass through

  const policyLevel = RiskLevel.MEDIUM;
  const floored = maxLevel(verdict.riskLevel, policyLevel);
  const reason = `Login/payment from high-risk country: ${country}`;

  return {
    ...verdict,
    riskLevel: floored,
    reasons: verdict.reasons.includes(reason) ? verdict.reasons : [...verdict.reasons, reason],
    modelScores: { ...(verdict.modelScores ?? {}), p_country_policy: 0.5 },
  };
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
