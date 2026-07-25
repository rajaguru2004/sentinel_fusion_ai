import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  async summary(@CurrentUser() user: JwtPayload) {
    const customerId = user.customerId;
    const [pending, held, blocked, lastLogin] = await Promise.all([
      this.prisma.payment.count({
        where: { customerId, status: { in: ['NEW', 'PENDING_AUTH', 'CHALLENGED'] } },
      }),
      this.prisma.payment.count({ where: { customerId, status: 'HELD' } }),
      this.prisma.payment.count({ where: { customerId, status: 'BLOCKED' } }),
      this.prisma.loginEvent.findFirst({
        where: { userId: user.sub, success: true },
        orderBy: { createdAt: 'desc' },
        skip: 1, // the previous successful login (not the current session)
      }),
    ]);

    return {
      pendingCount: pending,
      heldCount: held,
      blockedCount: blocked,
      lastLoginAt: lastLogin?.createdAt ?? null,
      info: {
        neftRtgsCutoff: '19:30',
        perTransactionLimit: '₹25,00,000',
        otpValiditySeconds: 100,
      },
    };
  }
}
