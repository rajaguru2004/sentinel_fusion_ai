import { Injectable, Logger } from '@nestjs/common';
import { RiskLevel } from '@prisma/client';
import { env } from '../common/env';
import { MailerService } from '../mailer/mailer.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RiskVerdict, UnifiedEvent } from './scorer.interface';
import type { Decision } from './fraud-gateway.service';

/** Band ordering — a level fires an alert when its rank >= the configured floor. */
const RANK: Record<RiskLevel, number> = {
  [RiskLevel.LOW]: 0,
  [RiskLevel.MEDIUM]: 1,
  [RiskLevel.HIGH]: 2,
  [RiskLevel.CRITICAL]: 3,
};

const ACCENT: Record<RiskLevel, string> = {
  [RiskLevel.LOW]: '#16a34a',
  [RiskLevel.MEDIUM]: '#d97706',
  [RiskLevel.HIGH]: '#ea580c',
  [RiskLevel.CRITICAL]: '#dc2626',
};

const DECISION_TEXT: Record<Decision, string> = {
  EXECUTE: 'Allowed to proceed',
  CHALLENGE: 'Step-up OTP challenge issued',
  HOLD: 'Payment held for analyst review',
  BLOCK: 'Payment blocked and account frozen',
};

export interface AlertContext {
  userId?: string;
  paymentId?: string;
  ip?: string;
  deviceFingerprint?: string;
}

/**
 * Mails a fraud alert for every scored event in an alerting band (§9).
 *
 * Addressed to the CUSTOMER the event belongs to, from RISK_ALERT_FROM. Events
 * with no resolvable customer email (no userId, or the user row is gone) go to
 * RISK_ALERT_FALLBACK_TO instead, so an alert is never silently dropped.
 *
 * Deliberately NOT deduplicated or throttled: one qualifying event produces one
 * mail, so a single isolated fault is never swallowed. Callers must not await
 * this — `notify()` swallows its own errors so a dead SMTP server can never
 * fail a payment.
 */
@Injectable()
export class RiskAlertService {
  private readonly logger = new Logger(RiskAlertService.name);

  constructor(
    private readonly mailer: MailerService,
    private readonly prisma: PrismaService,
  ) {}

  private get floor(): number {
    const configured = env.riskAlert.minLevel as RiskLevel;
    return RANK[configured] ?? RANK[RiskLevel.MEDIUM];
  }

  shouldAlert(level: RiskLevel): boolean {
    return env.riskAlert.enabled && RANK[level] >= this.floor;
  }

  /** Fire-and-forget. Never throws; never blocks the money path. */
  notify(
    event: UnifiedEvent,
    verdict: RiskVerdict,
    decision: Decision,
    ctx: AlertContext,
  ): void {
    if (!this.shouldAlert(verdict.riskLevel)) return;

    void this.send(event, verdict, decision, ctx).catch((err: unknown) => {
      this.logger.error(
        `Risk alert mail failed for ${event.eventId ?? event.eventType}: ${String(err)}`,
      );
    });
  }

  private async send(
    event: UnifiedEvent,
    verdict: RiskVerdict,
    decision: Decision,
    ctx: AlertContext,
  ): Promise<void> {
    const [user, payment] = await Promise.all([
      ctx.userId
        ? this.prisma.user.findUnique({
            where: { id: ctx.userId },
            select: { userId: true, email: true, mobile: true },
          })
        : Promise.resolve(null),
      ctx.paymentId
        ? this.prisma.payment.findUnique({
            where: { id: ctx.paymentId },
            select: { refNo: true, amount: true, rail: true, status: true },
          })
        : Promise.resolve(null),
    ]);

    const level = verdict.riskLevel;
    const pct = (verdict.riskScore * 100).toFixed(1);
    const subject = `[Sentinel ${level}] ${event.eventType} — risk ${pct}%${
      payment ? ` — ${payment.refNo}` : ''
    }`;

    const rows: [string, string][] = [
      ['Risk level', level],
      ['Risk score', `${verdict.riskScore.toFixed(4)} (${pct}%)`],
      ['Decision', `${decision} — ${DECISION_TEXT[decision]}`],
      ['Event type', event.eventType],
      ['Event ID', event.eventId ?? '—'],
      ['Time (UTC)', new Date().toISOString()],
      ['User', user ? `${user.userId} <${user.email}>` : (ctx.userId ?? '—')],
      ['IP address', ctx.ip ?? event.ip ?? '—'],
      ['Country', event.country ?? '—'],
      ['Device', ctx.deviceFingerprint ?? event.deviceFingerprint ?? '—'],
      ['Channel', event.channel ?? '—'],
    ];

    if (payment) {
      rows.push(
        ['Reference', payment.refNo],
        ['Amount', `INR ${(Number(payment.amount) / 100).toLocaleString('en-IN')}`],
        ['Rail', payment.rail],
        ['Payment status', payment.status],
      );
    }
    if (event.isNewBeneficiary != null) {
      rows.push(['New beneficiary', event.isNewBeneficiary ? 'YES' : 'no']);
    }
    if (event.txnCountLastHour != null) {
      rows.push(['Txns in last hour', String(event.txnCountLastHour)]);
    }
    if (event.amountVsUserMean != null) {
      rows.push(['Amount vs user mean', `${event.amountVsUserMean.toFixed(2)}x`]);
    }

    // The customer owns this alert; the fallback exists so an event without a
    // resolvable user (or with a deleted user row) still reaches someone.
    const recipient = user?.email || env.riskAlert.fallbackTo;
    if (!user?.email) {
      this.logger.warn(
        `No customer email for ${event.eventId ?? event.eventType} ` +
          `(userId=${ctx.userId ?? 'none'}) — alert routed to the fallback address`,
      );
    }

    await this.mailer.send(recipient, subject, this.html(level, rows, verdict), {
      from: env.riskAlert.from,
    });
  }

  private html(level: RiskLevel, rows: [string, string][], verdict: RiskVerdict): string {
    const accent = ACCENT[level];
    const cells = rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap">${esc(k)}</td>` +
          `<td style="padding:6px 0;color:#0f172a;font-weight:600">${esc(v)}</td></tr>`,
      )
      .join('');

    const reasons = verdict.reasons.length
      ? `<ul style="margin:8px 0 0;padding-left:20px;color:#334155">${verdict.reasons
          .map((r) => `<li style="margin:2px 0">${esc(r)}</li>`)
          .join('')}</ul>`
      : '<p style="color:#64748b;margin:8px 0 0">No explanation returned.</p>';

    const models = Object.entries(verdict.modelScores ?? {});
    const modelBlock = models.length
      ? `<h3 style="margin:20px 0 4px;font-size:14px;color:#0f172a">Model contributions</h3>
         <table style="border-collapse:collapse;font-size:13px">${models
           .map(
             ([k, v]) =>
               `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${esc(k)}</td>` +
               `<td style="padding:4px 0;color:#0f172a;font-weight:600">${v.toFixed(4)}</td></tr>`,
           )
           .join('')}</table>`
      : '';

    return `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px">
        <div style="background:${accent};color:#fff;padding:14px 18px;border-radius:8px 8px 0 0">
          <div style="font-size:12px;letter-spacing:1px;opacity:.85">SENTINEL FUSION AI</div>
          <div style="font-size:20px;font-weight:700">${esc(level)} RISK DETECTED</div>
        </div>
        <div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 8px 8px;padding:18px">
          <table style="border-collapse:collapse;font-size:13px;width:100%">${cells}</table>
          <h3 style="margin:20px 0 4px;font-size:14px;color:#0f172a">Why this scored</h3>
          ${reasons}
          ${modelBlock}
          <p style="margin:20px 0 0;font-size:12px;color:#94a3b8">
            Automated alert from the FinSpark fraud gateway. Every activity on your
            account scored at or above ${esc(env.riskAlert.minLevel)} is mailed to you
            individually — no batching. If you did not perform this activity, contact
            the bank immediately.
          </p>
        </div>
      </div>`;
  }
}

/** Model reasons and user input reach this template — escape before interpolating. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
