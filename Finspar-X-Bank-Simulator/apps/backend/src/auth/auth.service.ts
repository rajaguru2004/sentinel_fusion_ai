import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { FraudGateway } from '../fraud/fraud-gateway.service';
import { env } from '../common/env';
import type { LoginDto } from './dto/login.dto';
import type { JwtPayload } from './jwt.strategy';

interface LoginContext {
  ip?: string;
  userAgent?: string;
  mockCountry?: string; // dev mock-VPN override (X-Mock-Country header)
}

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly fraud: FraudGateway,
  ) {}

  async login(dto: LoginDto, ctx: LoginContext) {
    const user = await this.prisma.user.findUnique({
      where: { userId: dto.userId },
      include: { customers: { include: { customer: true } } },
    });

    // Uniform failure — never reveal whether the user or customer exists (§8.1.1).
    const invalid = (): never => {
      throw new UnauthorizedException('Invalid Customer Id, User Id or Password');
    };

    if (!user) return invalid();

    // Locked?
    if (user.lockedAt) {
      throw new ForbiddenException(
        'Account is locked due to failed login attempts. Use Unlock Me.',
      );
    }

    const link = user.customers.find((cu) => cu.customer.customerId === dto.customerId);
    if (!link) {
      await this.registerFailure(user.id, ctx);
      return invalid();
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      await this.registerFailure(user.id, ctx, dto.customerId);
      return invalid();
    }

    // Success — reset counters, stamp last login, record a LoginEvent (fraud seam).
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedAt: null, lastLoginAt: new Date() },
    });
    const loginEvent = await this.prisma.loginEvent.create({
      data: {
        userId: user.id,
        customerId: link.customerId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        deviceFingerprint: dto.deviceFingerprint,
        success: true,
      },
    });

    // Fraud seam — score the login through the behaviour model. Non-fatal: a
    // scoring error must never block a legitimate sign-in (fail open).
    try {
      const event = this.fraud.buildLoginEvent({
        userId: user.id,
        loginEventId: loginEvent.id,
        ctx: {
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          deviceFingerprint: dto.deviceFingerprint,
          sessionId: user.id,
          mockCountry: ctx.mockCountry,
        },
      });
      await this.fraud.assess(event, { userId: user.id, ip: ctx.ip, deviceFingerprint: dto.deviceFingerprint });
    } catch (err) {
      this.log.warn(`Login fraud scoring failed for ${user.userId}: ${String(err)}`);
    }

    const payload: JwtPayload = {
      sub: user.id,
      userId: user.userId,
      customerId: link.customerId,
      customerRef: link.customer.customerId,
      role: link.role,
    };

    return {
      accessToken: await this.jwt.signAsync(payload),
      user: {
        userId: user.userId,
        customerId: link.customer.customerId,
        customerName: link.customer.name,
        role: link.role,
        lastLoginAt: user.lastLoginAt,
        email: user.email,
        mobile: user.mobile,
      },
    };
  }

  /** Increment failed attempts; lock at LOGIN_MAX_ATTEMPTS. Also records a failed LoginEvent. */
  private async registerFailure(
    userId: string,
    ctx: LoginContext,
    customerRef?: string,
  ): Promise<void> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { failedAttempts: { increment: 1 } },
    });
    if (user.failedAttempts >= env.loginMaxAttempts && !user.lockedAt) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { lockedAt: new Date() },
      });
    }
    await this.prisma.loginEvent.create({
      data: {
        userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        deviceFingerprint: undefined,
        success: false,
      },
    });
  }

  // --- Login password change (§8.13) --------------------------------------
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const ok = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!ok) throw new BadRequestException('Current password is incorrect');

    await this.assertNotReused(userId, 'LOGIN', newPassword);

    const hash = await bcrypt.hash(newPassword, 10);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } }),
      this.prisma.passwordHistory.create({
        data: { userId, passwordHash: hash, kind: 'LOGIN' },
      }),
    ]);
  }

  // --- Transaction password change (§8.14) --------------------------------
  async changeTxnPassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (user.txnPasswordHash) {
      const ok = await bcrypt.compare(oldPassword, user.txnPasswordHash);
      if (!ok) throw new BadRequestException('Current transaction password is incorrect');
    }
    await this.assertNotReused(userId, 'TXN', newPassword);

    const hash = await bcrypt.hash(newPassword, 10);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { txnPasswordHash: hash } }),
      this.prisma.passwordHistory.create({
        data: { userId, passwordHash: hash, kind: 'TXN' },
      }),
    ]);
  }

  /** Read the current profile with fresh mobile/email (§8.12). */
  async getProfile(userId: string, customerId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { customers: { include: { customer: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    const link = user.customers.find((cu) => cu.customerId === customerId);
    return {
      userId: user.userId,
      customerId: link?.customer.customerId ?? '',
      customerName: link?.customer.name ?? '',
      role: link?.role ?? 'VIEWER',
      mobile: user.mobile,
      email: user.email,
    };
  }

  /** Update registered mobile/email — requires the login password to confirm. */
  async updateProfile(
    userId: string,
    password: string,
    changes: { mobile?: string; email?: string },
  ): Promise<{ mobile: string; email: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new BadRequestException('Incorrect password');

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        mobile: changes.mobile ?? user.mobile,
        email: changes.email ?? user.email,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'PROFILE_UPDATE',
        entity: 'USER',
        entityId: userId,
        before: { mobile: user.mobile, email: user.email },
        after: { mobile: updated.mobile, email: updated.email },
      },
    });
    return { mobile: updated.mobile, email: updated.email };
  }

  /** Reset login password without the old one — used by recovery after OTP (§8.1.1). */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    await this.assertNotReused(userId, 'LOGIN', newPassword);
    const hash = await bcrypt.hash(newPassword, 10);
    await this.prisma.$transaction([
      // Also clear any lock and failed attempts, and stamp the change.
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: hash, failedAttempts: 0, lockedAt: null },
      }),
      this.prisma.passwordHistory.create({
        data: { userId, passwordHash: hash, kind: 'LOGIN' },
      }),
    ]);
  }

  /** Reset transaction password (Generate Or Reset Txn Password) after OTP (§8.14). */
  async resetTxnPassword(userId: string, newPassword: string): Promise<void> {
    await this.assertNotReused(userId, 'TXN', newPassword);
    const hash = await bcrypt.hash(newPassword, 10);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { txnPasswordHash: hash } }),
      this.prisma.passwordHistory.create({ data: { userId, passwordHash: hash, kind: 'TXN' } }),
    ]);
  }

  /** Verify a transaction password — used by the payment flow (§8.10). */
  async verifyTxnPassword(userId: string, txnPassword: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.txnPasswordHash) return false;
    return bcrypt.compare(txnPassword, user.txnPasswordHash);
  }

  /** New password must differ from the last 3 hashes (§8.1.1). */
  private async assertNotReused(userId: string, kind: string, candidate: string): Promise<void> {
    const history = await this.prisma.passwordHistory.findMany({
      where: { userId, kind },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    for (const h of history) {
      if (await bcrypt.compare(candidate, h.passwordHash)) {
        throw new BadRequestException('New password must differ from your last 3 passwords');
      }
    }
  }
}
