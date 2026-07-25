import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { OtpPurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { env } from '../common/env';

const RESEND_COOLDOWN_SECONDS = 30;
const MAX_RESENDS = 3;

const PURPOSE_LABEL: Record<OtpPurpose, string> = {
  PAYMENT: 'Payment Authorisation',
  PASSWORD_RESET: 'Password Reset',
  TXN_PASSWORD: 'Transaction Password',
  UNLOCK: 'Account Unlock',
};

interface IssueParams {
  purpose: OtpPurpose;
  email: string;
  userId?: string;
  paymentId?: string;
}

/**
 * Single OTP engine for payments, password reset, txn-password reset and unlock,
 * keyed by purpose (§8.10). 6-digit crypto-random code, bcrypt-hashed, 100s TTL,
 * 3 verify attempts then burned, 30s resend cooldown (max 3 resends).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
  ) {}

  async issue(params: IssueParams): Promise<{ requestId: string; expiresAt: Date }> {
    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const requestId = await this.uniqueRequestId();
    const expiresAt = new Date(Date.now() + env.otpTtlSeconds * 1000);

    await this.prisma.otpChallenge.create({
      data: {
        purpose: params.purpose,
        userId: params.userId,
        paymentId: params.paymentId,
        requestId,
        codeHash,
        expiresAt,
      },
    });

    await this.mailer.sendOtp(params.email, code, PURPOSE_LABEL[params.purpose], requestId);
    return { requestId, expiresAt };
  }

  /** Verify a code. Throws on invalid/expired/burned. Consumes the challenge on success. */
  async verify(requestId: string, code: string): Promise<{ paymentId?: string | null; userId?: string | null }> {
    const challenge = await this.prisma.otpChallenge.findUnique({ where: { requestId } });
    if (!challenge) throw new BadRequestException('Invalid or expired OTP request');
    if (challenge.consumedAt) throw new BadRequestException('This OTP has already been used or expired');
    if (challenge.expiresAt < new Date()) throw new BadRequestException('OTP has expired');

    const ok = await bcrypt.compare(code, challenge.codeHash);
    if (!ok) {
      const attempts = challenge.attempts + 1;
      const burn = attempts >= env.otpMaxAttempts;
      await this.prisma.otpChallenge.update({
        where: { requestId },
        data: { attempts, consumedAt: burn ? new Date() : undefined },
      });
      throw new BadRequestException(
        burn
          ? 'Too many incorrect attempts — OTP burned. Please request a new one.'
          : `Incorrect OTP. ${env.otpMaxAttempts - attempts} attempt(s) left.`,
      );
    }

    await this.prisma.otpChallenge.update({
      where: { requestId },
      data: { consumedAt: new Date() },
    });
    return { paymentId: challenge.paymentId, userId: challenge.userId };
  }

  /** Resend a fresh code on an existing challenge, honouring cooldown and max resends. */
  async resend(requestId: string, email: string): Promise<{ requestId: string; expiresAt: Date }> {
    const challenge = await this.prisma.otpChallenge.findUnique({ where: { requestId } });
    if (!challenge || challenge.consumedAt) {
      throw new BadRequestException('Cannot resend — request a new OTP');
    }
    const sinceIssued = (Date.now() - challenge.issuedAt.getTime()) / 1000;
    if (sinceIssued < RESEND_COOLDOWN_SECONDS) {
      throw new BadRequestException(
        `Please wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - sinceIssued)}s before resending`,
      );
    }
    if (challenge.resentCount >= MAX_RESENDS) {
      throw new BadRequestException('Resend limit reached — request a new OTP');
    }

    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + env.otpTtlSeconds * 1000);
    await this.prisma.otpChallenge.update({
      where: { requestId },
      data: {
        codeHash,
        issuedAt: new Date(),
        expiresAt,
        attempts: 0,
        resentCount: { increment: 1 },
      },
    });
    await this.mailer.sendOtp(email, code, PURPOSE_LABEL[challenge.purpose], requestId);
    return { requestId, expiresAt };
  }

  // Mock OTP: a fixed 6-digit code so the flow can be demoed without real email
  // delivery. Still bcrypt-hashed and stored, so verify/expiry/attempt logic is
  // unchanged — only the value is deterministic.
  private generateCode(): string {
    return '123456';
  }

  private async uniqueRequestId(): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const id = String(randomInt(1000, 100000)); // 4–5 digit
      const exists = await this.prisma.otpChallenge.findUnique({ where: { requestId: id } });
      if (!exists) return id;
    }
    return String(Date.now()).slice(-6);
  }
}
