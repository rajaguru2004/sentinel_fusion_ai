import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, LedgerDirection, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Double-entry ledger. Every payment writes matched DEBIT (source account) and
 * CREDIT (settlement counter-account) rows; balances are recomputed, never
 * mutated blind (§10). Also handles fraud/cutoff holds via holdAmount.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** A per-customer counter-account so external transfers keep the books balanced. */
  private async settlementAccount(tx: Prisma.TransactionClient, customerId: string, currency: string) {
    const number = `SETTLE-${customerId}`;
    const existing = await tx.account.findUnique({ where: { accountNumber: number } });
    if (existing) return existing;
    return tx.account.create({
      data: {
        customerId,
        accountNumber: number,
        accountName: 'External Settlement',
        accountType: 'CURRENT',
        currency,
      },
    });
  }

  /** Post a payment to the ledger and mark it COMPLETED. */
  async postPayment(paymentId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) throw new BadRequestException('Payment not found');

      const source = await tx.account.findUnique({ where: { id: payment.debitAccountId } });
      if (!source) throw new BadRequestException('Debit account not found');

      const available = source.clearBalance - source.holdAmount;
      if (available < payment.amount) {
        throw new BadRequestException('Insufficient available balance');
      }

      const newSourceBalance = source.clearBalance - payment.amount;
      await tx.account.update({ where: { id: source.id }, data: { clearBalance: newSourceBalance } });
      await tx.ledgerEntry.create({
        data: {
          paymentId,
          accountId: source.id,
          direction: LedgerDirection.DEBIT,
          amount: payment.amount,
          balanceAfter: newSourceBalance,
          description: payment.paymentMode,
        },
      });

      const settlement = await this.settlementAccount(tx, payment.customerId, source.currency);
      const newSettleBalance = settlement.clearBalance + payment.amount;
      await tx.account.update({ where: { id: settlement.id }, data: { clearBalance: newSettleBalance } });
      await tx.ledgerEntry.create({
        data: {
          paymentId,
          accountId: settlement.id,
          direction: LedgerDirection.CREDIT,
          amount: payment.amount,
          balanceAfter: newSettleBalance,
          description: `Settlement for ${payment.refNo}`,
        },
      });

      await tx.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.COMPLETED, postedAt: new Date() },
      });
    });
    this.logger.log(`Posted payment ${paymentId}`);
  }

  /** Move funds to holdAmount (fraud HIGH band or cutoff/over-limit) and mark HELD. */
  async holdPayment(paymentId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) throw new BadRequestException('Payment not found');
      await tx.account.update({
        where: { id: payment.debitAccountId },
        data: { holdAmount: { increment: payment.amount } },
      });
      await tx.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.HELD } });
    });
    this.logger.warn(`Held payment ${paymentId}`);
  }

  /**
   * Release a fraud hold: return the reserved funds to the account and set the
   * payment to `newStatus`. Used by the analyst release/reject flow — release
   * sends it back to the maker (NEW) to re-authorise; reject cancels it.
   */
  async releaseHold(paymentId: string, newStatus: PaymentStatus): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) throw new BadRequestException('Payment not found');
      if (payment.status !== PaymentStatus.HELD) {
        throw new BadRequestException('Only a HELD payment can be released');
      }
      await tx.account.update({
        where: { id: payment.debitAccountId },
        data: { holdAmount: { decrement: payment.amount } },
      });
      await tx.payment.update({ where: { id: paymentId }, data: { status: newStatus } });
    });
    this.logger.log(`Released hold on ${paymentId} -> ${newStatus}`);
  }

  /**
   * NEFT/RTGS cut-off job. Runs on weekdays at 19:30; releases HELD-by-cutoff
   * payments (valueDate reached) into the ledger. Fraud holds are left untouched
   * (they have a riskLevel of HIGH/CRITICAL).
   */
  @Cron('30 19 * * 1-5')
  async runCutoff(): Promise<void> {
    const due = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.HELD,
        riskLevel: null,
        valueDate: { lte: new Date() },
      },
    });
    for (const p of due) {
      await this.prisma.account.update({
        where: { id: p.debitAccountId },
        data: { holdAmount: { decrement: p.amount } },
      });
      await this.postPayment(p.id).catch((e) => this.logger.error(e));
    }
    if (due.length) this.logger.log(`Cut-off processed ${due.length} payment(s)`);
  }
}
