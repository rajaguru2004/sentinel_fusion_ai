/**
 * Money-path invariant checks (ENHANCEMENTS.md §1).
 *
 * Proves the two properties that are impossible to demonstrate by clicking:
 *
 *   1. The conditional debit is atomic — N concurrent debits against a balance
 *      that only covers one must produce exactly one winner.
 *   2. The ledger idempotency key holds — two DEBIT rows for one payment are
 *      rejected by the database, not by application logic that could be bypassed.
 *
 * Operates on a scratch account it creates and deletes; it never touches seeded
 * data. Read-only with respect to everything else.
 *
 * Run from apps/backend:  node scripts/verify-money-path.mjs
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SCRATCH = 'VERIFY-SCRATCH-0001';

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
};

async function scratchAccount() {
  const customer = await prisma.customer.findFirst();
  if (!customer) throw new Error('No customer found — run `npm run db:seed` first.');

  await cleanup();
  return prisma.account.create({
    data: {
      customerId: customer.id,
      accountNumber: SCRATCH,
      accountName: 'Verification Scratch',
      accountType: 'CURRENT',
      currency: 'INR',
      clearBalance: 10000n, // ₹100.00 in paise
      holdAmount: 0n,
    },
  });
}

async function cleanup() {
  const existing = await prisma.account.findUnique({ where: { accountNumber: SCRATCH } });
  if (!existing) return;
  await prisma.ledgerEntry.deleteMany({ where: { accountId: existing.id } });
  await prisma.account.delete({ where: { id: existing.id } });
}

/** The exact statement LedgerService.debitIfSufficient issues. */
function debit(accountId, amount) {
  return prisma.$executeRaw`
    UPDATE "accounts"
       SET "clearBalance" = "clearBalance" - ${amount},
           "updatedAt"    = NOW()
     WHERE "id" = ${accountId}
       AND "clearBalance" - "holdAmount" >= ${amount}
  `;
}

async function testAtomicDebit() {
  console.log('\n1. Atomic conditional debit under concurrency');
  const account = await scratchAccount();

  // ₹100 available, ten simultaneous ₹60 debits. Exactly one may succeed.
  const amount = 6000n;
  const results = await Promise.all(Array.from({ length: 10 }, () => debit(account.id, amount)));
  const winners = results.filter((rows) => rows > 0).length;

  const after = await prisma.account.findUnique({ where: { id: account.id } });

  if (winners === 1) ok(`exactly 1 of 10 concurrent debits succeeded`);
  else bad(`${winners} of 10 concurrent debits succeeded — expected exactly 1 (double-spend!)`);

  if (after.clearBalance === 4000n) ok(`balance is ₹40.00 as expected`);
  else bad(`balance is ${Number(after.clearBalance) / 100} — expected ₹40.00`);

  if (after.clearBalance >= 0n) ok(`balance never went negative`);
  else bad(`balance went NEGATIVE (${after.clearBalance})`);

  await cleanup();
}

async function testHoldNeverNegative() {
  console.log('\n2. Guarded hold release cannot drive holdAmount negative');
  const account = await scratchAccount();
  await prisma.account.update({ where: { id: account.id }, data: { holdAmount: 5000n } });

  // The guarded release from LedgerService.releaseHoldIfHeld, fired five times
  // for a hold that only exists once — the runCutoff re-release scenario.
  const release = () => prisma.$executeRaw`
    UPDATE "accounts"
       SET "holdAmount" = "holdAmount" - ${5000n}
     WHERE "id" = ${account.id}
       AND "holdAmount" >= ${5000n}
  `;
  const results = await Promise.all(Array.from({ length: 5 }, release));
  const winners = results.filter((r) => r > 0).length;
  const after = await prisma.account.findUnique({ where: { id: account.id } });

  if (winners === 1) ok(`exactly 1 of 5 repeated releases applied`);
  else bad(`${winners} of 5 releases applied — expected exactly 1`);

  if (after.holdAmount === 0n) ok(`holdAmount settled at 0`);
  else bad(`holdAmount is ${after.holdAmount} — expected 0`);

  await cleanup();
}

async function testIdempotencyIndex() {
  console.log('\n3. Ledger idempotency key is enforced by the database');
  const index = await prisma.$queryRaw`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'ledger_entries'
       AND indexdef ILIKE '%UNIQUE%'
       AND indexdef ILIKE '%paymentId%'
       AND indexdef ILIKE '%direction%'
  `;
  if (index.length) {
    ok(`unique index present: ${index[0].indexname}`);
  } else {
    bad('unique (paymentId, direction) index MISSING — run `npm run db:migrate`');
    return; // the write test below is meaningless without it
  }

  const payment = await prisma.payment.findFirst({ where: { status: 'COMPLETED' } });
  if (!payment) {
    console.log('  \x1b[33mSKIP\x1b[0m no COMPLETED payment to test a duplicate against');
    return;
  }
  const existing = await prisma.ledgerEntry.findFirst({
    where: { paymentId: payment.id, direction: 'DEBIT' },
  });
  if (!existing) {
    console.log('  \x1b[33mSKIP\x1b[0m that payment has no DEBIT row');
    return;
  }

  try {
    await prisma.ledgerEntry.create({
      data: {
        paymentId: existing.paymentId,
        accountId: existing.accountId,
        direction: 'DEBIT',
        amount: existing.amount,
        balanceAfter: existing.balanceAfter,
        description: 'verification duplicate — should be rejected',
      },
    });
    bad('a duplicate DEBIT row was ACCEPTED — idempotency key is not working');
    // Undo the row we should not have been able to write.
    await prisma.ledgerEntry.deleteMany({
      where: { description: 'verification duplicate — should be rejected' },
    });
  } catch (e) {
    if (e.code === 'P2002') ok('duplicate DEBIT row rejected by the unique constraint');
    else bad(`rejected, but with an unexpected error: ${e.code ?? e.message}`);
  }
}

async function main() {
  console.log('Money-path verification (ENHANCEMENTS.md §1)');
  try {
    await testAtomicDebit();
    await testHoldNeverNegative();
    await testIdempotencyIndex();
  } finally {
    await cleanup().catch(() => {});
    await prisma.$disconnect();
  }
  console.log(
    failures === 0
      ? '\n\x1b[32mAll money-path invariants hold.\x1b[0m'
      : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n\x1b[31mVerification could not run:\x1b[0m', e.message);
  await prisma.$disconnect();
  process.exit(2);
});
