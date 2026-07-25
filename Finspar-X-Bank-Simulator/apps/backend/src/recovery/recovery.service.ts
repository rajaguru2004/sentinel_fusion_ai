import { Injectable, BadRequestException } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from '../otp/otp.service';
import { MailerService } from '../mailer/mailer.service';
import { AuthService } from '../auth/auth.service';

const NEUTRAL_USER_ID = 'If the details match our records, your User Id has been emailed.';
const NEUTRAL_OTP = 'If the details match our records, an OTP has been sent to the registered email.';

// Simple in-memory rate limit: 5 requests per identity per hour (single-instance demo).
const RATE_LIMIT = 5;
const WINDOW_MS = 60 * 60 * 1000;

@Injectable()
export class RecoveryService {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly mailer: MailerService,
    private readonly auth: AuthService,
  ) {}

  private rateLimit(identity: string): void {
    const now = Date.now();
    const recent = (this.hits.get(identity) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      throw new BadRequestException('Too many requests. Please try again later.');
    }
    recent.push(now);
    this.hits.set(identity, recent);
  }

  private maskUserId(userId: string): string {
    if (userId.length <= 4) return userId[0] + '***';
    return `${userId.slice(0, 3)}${'*'.repeat(Math.max(2, userId.length - 5))}${userId.slice(-2)}`;
  }

  private async audit(action: string, entityId: string | null, after?: object): Promise<void> {
    await this.prisma.auditLog.create({
      data: { action, entity: 'RECOVERY', entityId, after: after ?? undefined },
    });
  }

  // --- Forgot User Id (§8.1.1) --------------------------------------------
  async forgotUserId(customerId: string, email?: string, mobile?: string): Promise<{ message: string }> {
    this.rateLimit(`fuid:${customerId}:${email ?? mobile ?? ''}`);
    const customer = await this.prisma.customer.findUnique({
      where: { customerId },
      include: { users: { include: { user: true } } },
    });
    const match = customer?.users.find(
      (cu) => (email && cu.user.email === email) || (mobile && cu.user.mobile === mobile),
    );
    if (match) {
      const masked = this.maskUserId(match.user.userId);
      await this.mailer.send(
        match.user.email,
        'Bank of Maharashtra — Your User Id',
        `<p>Your User Id is <strong>${masked}</strong>.</p>`,
      );
      await this.audit('FORGOT_USER_ID_MATCH', match.userId);
    } else {
      await this.audit('FORGOT_USER_ID_NO_MATCH', null, { customerId });
    }
    // Always identical response (§8.1.1 — no account enumeration).
    return { message: NEUTRAL_USER_ID };
  }

  // --- Forgot Login / Txn Password (§8.1.1, §8.14) ------------------------
  async forgotPasswordRequest(
    customerId: string,
    userId: string,
    purpose: 'PASSWORD_RESET' | 'TXN_PASSWORD' = 'PASSWORD_RESET',
  ): Promise<{ message: string; requestId?: string }> {
    this.rateLimit(`fp:${customerId}:${userId}`);
    const user = await this.resolveUser(customerId, userId);
    if (!user) {
      await this.audit('FORGOT_PASSWORD_NO_MATCH', null, { customerId, userId });
      return { message: NEUTRAL_OTP };
    }
    const { requestId } = await this.otp.issue({
      purpose: purpose as OtpPurpose,
      email: user.email,
      userId: user.id,
    });
    await this.audit('FORGOT_PASSWORD_OTP_ISSUED', user.id, { purpose });
    return { message: NEUTRAL_OTP, requestId };
  }

  async resetPassword(requestId: string, code: string, newPassword: string): Promise<{ message: string }> {
    const { userId } = await this.otp.verify(requestId, code);
    if (!userId) throw new BadRequestException('Invalid OTP request');
    const challenge = await this.prisma.otpChallenge.findUnique({ where: { requestId } });
    const isTxn = challenge?.purpose === OtpPurpose.TXN_PASSWORD;

    if (isTxn) {
      await this.auth.resetTxnPassword(userId, newPassword);
    } else {
      await this.auth.resetPassword(userId, newPassword);
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      await this.mailer.send(
        user.email,
        `Bank of Maharashtra — ${isTxn ? 'Transaction' : 'Login'} password changed`,
        `<p>Your ${isTxn ? 'transaction' : 'login'} password was changed. If this wasn't you, contact support immediately.</p>`,
      );
    }
    await this.audit('PASSWORD_RESET_DONE', userId, { isTxn });
    // NOTE: JWTs are short-lived (15m); natural expiry stands in for session revocation.
    return { message: `${isTxn ? 'Transaction' : 'Login'} password updated. Please sign in.` };
  }

  // --- Unlock Me (§8.1.1) -------------------------------------------------
  async unlockRequest(customerId: string, userId: string): Promise<{ message: string; requestId?: string }> {
    this.rateLimit(`unlock:${customerId}:${userId}`);
    const user = await this.resolveUser(customerId, userId);
    // If not locked (or unknown), return neutral and stop — no OTP.
    if (!user || !user.lockedAt) {
      await this.audit('UNLOCK_NOOP', user?.id ?? null, { customerId, userId });
      return { message: NEUTRAL_OTP };
    }
    const { requestId } = await this.otp.issue({
      purpose: OtpPurpose.UNLOCK,
      email: user.email,
      userId: user.id,
    });
    await this.audit('UNLOCK_OTP_ISSUED', user.id);
    return { message: NEUTRAL_OTP, requestId };
  }

  async unlockVerify(requestId: string, code: string): Promise<{ message: string }> {
    const { userId } = await this.otp.verify(requestId, code);
    if (!userId) throw new BadRequestException('Invalid OTP request');
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedAttempts: 0, lockedAt: null },
    });
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      await this.mailer.send(
        user.email,
        'Bank of Maharashtra — Account unlocked',
        `<p>Your account has been unlocked. Note: your password was not changed. If you forgot it, use Forgot Login Password.</p>`,
      );
    }
    await this.audit('UNLOCK_DONE', userId);
    return { message: 'Account unlocked. You can sign in now.' };
  }

  async resend(requestId: string): Promise<{ message: string; requestId: string }> {
    const challenge = await this.prisma.otpChallenge.findUnique({ where: { requestId } });
    if (!challenge?.userId) throw new BadRequestException('Cannot resend — request a new OTP');
    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId } });
    if (!user) throw new BadRequestException('Cannot resend — request a new OTP');
    const res = await this.otp.resend(requestId, user.email);
    return { message: 'A new OTP has been sent.', requestId: res.requestId };
  }

  private async resolveUser(customerId: string, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { userId },
      include: { customers: { include: { customer: true } } },
    });
    if (!user) return null;
    const linked = user.customers.some((cu) => cu.customer.customerId === customerId);
    return linked ? user : null;
  }
}
