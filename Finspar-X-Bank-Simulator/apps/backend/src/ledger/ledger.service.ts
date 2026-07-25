import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, LedgerDirection, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Outcome of a post attempt, so callers can tell a fresh post from a replay. */
export type PostResult = 'POSTED' | 'ALREADY_POSTED';

/**
 * Double-entry ledger. Every payment writes matched DEBIT (source account) and
 * CREDIT (settlement counter-account) rows; balances are recomputed, never
 * mutated blind (§10). Also handles fraud/cutoff holds via holdAmount.
 *
 * Money-path invariants (see ENHANCEMENTS.md §1):
 *
 * 1. The balance check and the debit are ONE atomic statement — a conditional
 *    `UPDATE … WHERE clearBalance - holdAmount >= amount`. There is no
 *    read-then-write window for a concurrent payment to slip through, so the
 *    account cannot be overdrawn under Read Committed.
 * 2. Releasing a fraud/cut-off hold happens INSIDE the posting transaction, so a
 *    failed post rolls the release back with it. The hold can never be returned
 *    to a payment that did not actually post.
 * 3. The `(paymentId, direction)` unique index on ledger_entries is the
 *    idempotency key: a second post for the same payment aborts on the
 *    constraint. Replays are detected up front and reported, not re-applied.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Make sure the per-customer settlement counter-account exists.
   *
   * Deliberately runs OUTSIDE the posting transaction: a create that loses a
   * race on the `accountNumber` unique index raises P2002, and inside a Postgres
   * transaction that aborts the whole thing — taking a legitimate payment down
   * with it. Out here the loser can simply re-read the winner's row.
   */
  private async ensureSettlementAccount(customerId: string, currency: string): Promise<string> {
    const number = `SETTLE-${customerId}`;
    const existing = await this.prisma.account.findUnique({ where: { accountNumber: number } });
    if (existing) return existing.id;
    try {
      const created = await this.prisma.account.create({
        data: {
          customerId,
          accountNumber: number,
          accountName: 'External Settlement',
          accountType: 'CURRENT',
          currency,
        },
      });
      return created.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.account.findUnique({ where: { accountNumber: number } });
        if (winner) return winner.id;
      }
      throw e;
    }
  }

  /**
   * Debit `amount` from an account only if the funds are actually available.
   *
   * The check and the write are the same statement, so nothing can change the
   * balance between them. Returns false when no row matched — i.e. insufficient
   * available balance — which the caller turns into a rejection.
   */
  private async debitIfSufficient(
    tx: Prisma.TransactionClient,
    accountId: string,
    amount: bigint,
  ): Promise<boolean> {
    const rows = await tx.$executeRaw`
      UPDATE "accounts"
         SET "clearBalance" = "clearBalance" - ${amount},
             "updatedAt"    = NOW()
       WHERE "id" = ${accountId}
         AND "clearBalance" - "holdAmount" >= ${amount}
    `;
    return rows > 0;
  }

  /**
   * Release up to `amount` of an account's hold, clamped at zero.
   *
   * `GREATEST(… , 0)` is what makes this safe to call twice: releasing a hold
   * that is already gone is a no-op instead of a decrement, so holdAmount can
   * never go negative (which would inflate `clearBalance - holdAmount` and
   * defeat the availability check above). That is the compounding bug the naive
   * `decrement` had.
   *
   * It deliberately does NOT refuse when the held amount is short of `amount`.
   * An earlier version did, and it stranded real payments: this database
   * contains HELD payments whose accounts hold nothing — the fingerprint of the
   * old release-then-fail cut-off loop. Refusing to release those means they can
   * never be released or rejected by anyone, which is worse than the
   * inconsistency it was guarding against. Releasing what is actually there,
   * and saying so loudly, both preserves the invariant and lets an operator
   * clear the backlog.
   *
   * Returns the amount actually released, so the caller can log a shortfall.
   */
  private async releaseHoldUpTo(
    tx: Prisma.TransactionClient,
    accountId: string,
    amount: bigint,
  ): Promise<bigint> {
    const [row] = await tx.$queryRaw<{ before: bigint; after: bigint }[]>`
      WITH prev AS (SELECT "holdAmount" AS before FROM "accounts" WHERE "id" = ${accountId})
      UPDATE "accounts"
         SET "holdAmount" = GREATEST("holdAmount" - ${amount}, 0),
             "updatedAt"  = NOW()
        FROM prev
       WHERE "accounts"."id" = ${accountId}
      RETURNING prev.before AS before, "accounts"."holdAmount" AS after
    `;
    if (!row) return 0n;
    return BigInt(row.before) - BigInt(row.after);
  }

  /** Log an under-release once, in the one place every release path goes through. */
  private warnShortHold(paymentId: string, expected: bigint, released: bigint): void {
    if (released >= expected) return;
    this.logger.warn(
      `Payment ${paymentId}: expected a hold of ${expected} but only ${released} was held. ` +
        `Released what existed and continued. This account's holdAmount was left ` +
        `inconsistent by an earlier release — no funds were lost, but it is worth reconciling.`,
    );
  }

  /**
   * Post a payment to the ledger and mark it COMPLETED.
   *
   * Idempotent: posting an already-COMPLETED payment is a no-op that reports
   * `ALREADY_POSTED` rather than double-debiting. If the payment is currently
   * HELD (fraud hold or cut-off deferral) its hold is released as part of the
   * same transaction.
   */
  async postPayment(paymentId: string): Promise<PostResult> {
    // Resolve the counter-account before opening the transaction (see above).
    const pre = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { debitAccount: { select: { currency: true } } },
    });
    if (!pre) throw new BadRequestException('Payment not found');
    if (pre.status === PaymentStatus.COMPLETED) {
      this.logger.warn(`postPayment(${paymentId}) ignored — already COMPLETED`);
      return 'ALREADY_POSTED';
    }
    const settlementId = await this.ensureSettlementAccount(pre.customerId, pre.debitAccount.currency);

    try {
      await this.prisma.$transaction(async (tx) => {
        const payment = await tx.payment.findUnique({ where: { id: paymentId } });
        if (!payment) throw new BadRequestException('Payment not found');
        // Re-checked inside the transaction: the status may have moved between
        // the pre-flight read and here.
        if (payment.status === PaymentStatus.COMPLETED) {
          throw new AlreadyPosted();
        }

        // A HELD payment reserved its funds in holdAmount. Release the reservation
        // first, in this same transaction, so the availability check below sees the
        // funds and a failure downstream rolls the release back.
        if (payment.status === PaymentStatus.HELD) {
          const released = await this.releaseHoldUpTo(tx, payment.debitAccountId, payment.amount);
          this.warnShortHold(paymentId, payment.amount, released);
        }

        const debited = await this.debitIfSufficient(tx, payment.debitAccountId, payment.amount);
        if (!debited) throw new BadRequestException('Insufficient available balance');

        // Read back the post-debit balance for the ledger narration. Inside the
        // transaction this reflects our own write.
        const source = await tx.account.findUniqueOrThrow({ where: { id: payment.debitAccountId } });
        await tx.ledgerEntry.create({
          data: {
            paymentId,
            accountId: source.id,
            direction: LedgerDirection.DEBIT,
            amount: payment.amount,
            balanceAfter: source.clearBalance,
            description: payment.paymentMode,
          },
        });

        const settlement = await tx.account.update({
          where: { id: settlementId },
          data: { clearBalance: { increment: payment.amount } },
        });
        await tx.ledgerEntry.create({
          data: {
            paymentId,
            accountId: settlement.id,
            direction: LedgerDirection.CREDIT,
            amount: payment.amount,
            balanceAfter: settlement.clearBalance,
            description: `Settlement for ${payment.refNo}`,
          },
        });

        await tx.payment.update({
          where: { id: paymentId },
          data: { status: PaymentStatus.COMPLETED, postedAt: new Date() },
        });
      });
    } catch (e) {
      if (e instanceof AlreadyPosted) {
        this.logger.warn(`postPayment(${paymentId}) ignored — already COMPLETED`);
        return 'ALREADY_POSTED';
      }
      // The (paymentId, direction) unique index fired: a concurrent post won the
      // race. Nothing of ours committed — report it as a replay, not a failure.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        this.logger.warn(`postPayment(${paymentId}) lost the idempotency race — already posted`);
        return 'ALREADY_POSTED';
      }
      throw e;
    }

    this.logger.log(`Posted payment ${paymentId}`);
    return 'POSTED';
  }

  /** Move funds to holdAmount (fraud HIGH band or cutoff/over-limit) and mark HELD. */
  async holdPayment(paymentId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) throw new BadRequestException('Payment not found');
      if (payment.status === PaymentStatus.HELD) return; // already reserved — don't double-hold
      if (payment.status === PaymentStatus.COMPLETED) {
        throw new ConflictException('Cannot hold a completed payment');
      }
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
   *
   * The HELD status check and the guarded decrement together make this safe to
   * call twice: the second call finds a non-HELD payment and refuses.
   */
  async releaseHold(paymentId: string, newStatus: PaymentStatus): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) throw new BadRequestException('Payment not found');
      // The status check is the real idempotency guard here: a second release
      // finds a non-HELD payment and stops. The clamped decrement below is the
      // safety net for the funds themselves.
      if (payment.status !== PaymentStatus.HELD) {
        throw new BadRequestException('Only a HELD payment can be released');
      }
      const released = await this.releaseHoldUpTo(tx, payment.debitAccountId, payment.amount);
      this.warnShortHold(paymentId, payment.amount, released);
      await tx.payment.update({ where: { id: paymentId }, data: { status: newStatus } });
    });
    this.logger.log(`Released hold on ${paymentId} -> ${newStatus}`);
  }

  /**
   * NEFT/RTGS cut-off job. Runs on weekdays at 19:30; releases HELD-by-cutoff
   * payments (valueDate reached) into the ledger. Fraud holds are left untouched
   * (they have a riskLevel of HIGH/CRITICAL).
   *
   * The hold release now happens inside postPayment's transaction, so a failing
   * post leaves the payment exactly as it was — still HELD, funds still
   * reserved — and the next run retries it cleanly instead of releasing the
   * hold a second time.
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
    let posted = 0;
    for (const p of due) {
      try {
        if ((await this.postPayment(p.id)) === 'POSTED') posted++;
      } catch (e) {
        this.logger.error(`Cut-off post failed for ${p.id} (hold retained): ${String(e)}`);
      }
    }
    if (due.length) this.logger.log(`Cut-off processed ${posted}/${due.length} payment(s)`);
  }
}

/** Internal control-flow signal: the payment was already COMPLETED. */
class AlreadyPosted extends Error {}
