import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SentinelIngest } from '../fraud/sentinel-ingest';

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: SentinelIngest,
  ) {}

  /** Account Balance screen (§8.3). Derives available & effective-available. */
  async balances(customerId: string, accountType?: 'DEPOSIT' | 'FD', actorUserId?: string) {
    if (actorUserId) {
      // Low-value context event — non-blocking, builds velocity/history.
      this.ingest.stream({
        eventId: `bal:${actorUserId}:${Date.now()}`,
        eventType: 'BALANCE_VIEW',
        userId: actorUserId,
        timestamp: new Date().toISOString(),
      });
    }
    const where: { customerId: string; accountType?: AccountType | { in: AccountType[] } } = {
      customerId,
    };
    if (accountType === 'FD') where.accountType = AccountType.FD_TD;
    else if (accountType === 'DEPOSIT')
      where.accountType = { in: [AccountType.SAVINGS, AccountType.CURRENT] };

    const accounts = await this.prisma.account.findMany({
      where,
      orderBy: { accountNumber: 'asc' },
    });

    return accounts.map((a) => {
      const available = a.clearBalance - a.holdAmount;
      return {
        id: a.id,
        accountNumber: a.accountNumber,
        accountName: a.accountName,
        accountType: a.accountType,
        schemeType: a.schemeType,
        currency: a.currency,
        clearBalance: a.clearBalance,
        fundsInClearing: a.fundsInClearing,
        holdAmount: a.holdAmount,
        fdBalance: a.fdBalance,
        availableBalance: available,
        effectiveAvailable: available + a.fdBalance,
      };
    });
  }

  private async ownedAccount(customerId: string, accountNumber: string) {
    const account = await this.prisma.account.findFirst({
      where: { customerId, accountNumber },
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  /** Account Statement (§8.4). Statement rows carry a risk badge where scored. */
  async statement(
    customerId: string,
    accountNumber: string,
    opts: { from?: Date; to?: Date; order?: 'asc' | 'desc' },
    actorUserId?: string,
  ) {
    const account = await this.ownedAccount(customerId, accountNumber);
    if (actorUserId) {
      this.ingest.stream({
        eventId: `stmt:${actorUserId}:${Date.now()}`,
        eventType: 'STATEMENT_VIEW',
        userId: actorUserId,
        timestamp: new Date().toISOString(),
      });
    }
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        accountId: account.id,
        postedAt: {
          gte: opts.from,
          lte: opts.to,
        },
      },
      orderBy: { postedAt: opts.order ?? 'desc' },
      include: { payment: { select: { refNo: true, riskLevel: true } } },
      take: 500,
    });
    return entries.map(this.toRow);
  }

  /** Mini Statement (§8.5) — last N, table only. */
  async miniStatement(customerId: string, accountNumber: string, n = 10) {
    const account = await this.ownedAccount(customerId, accountNumber);
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { accountId: account.id },
      orderBy: { postedAt: 'desc' },
      include: { payment: { select: { refNo: true, riskLevel: true } } },
      take: n,
    });
    return entries.map(this.toRow);
  }

  /** Portfolio Statement (§8.6). */
  async portfolio(customerId: string) {
    const accounts = await this.prisma.account.findMany({
      where: { customerId },
      orderBy: { accountNumber: 'asc' },
    });
    return accounts.map((a) => ({
      accountName: a.accountName,
      accountNumber: a.accountNumber,
      availableAmount: a.clearBalance - a.holdAmount,
      currency: a.currency,
      schemeType: a.schemeType,
    }));
  }

  private toRow(e: {
    id: string;
    direction: string;
    amount: bigint;
    balanceAfter: bigint;
    description: string | null;
    postedAt: Date;
    valueDate: Date;
    payment: { refNo: string; riskLevel: string | null } | null;
  }) {
    return {
      id: e.id,
      date: e.postedAt,
      valueDate: e.valueDate,
      description: e.description ?? e.payment?.refNo ?? 'Transaction',
      refNo: e.payment?.refNo ?? null,
      direction: e.direction,
      amount: e.amount,
      balanceAfter: e.balanceAfter,
      riskLevel: e.payment?.riskLevel ?? null,
    };
  }
}
