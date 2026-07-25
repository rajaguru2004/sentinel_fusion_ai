/**
 * FinSpark seed — fabricated Indian corporate-banking test data.
 * 1 customer, 3 users (Maker/Authorizer/Viewer), 2 accounts, 8 beneficiaries.
 * All money is BigInt paise. Idempotent (upserts on natural keys).
 *
 * NOTE: none of this is real data. See BANK_SIMULATOR_SPEC.md §14.
 */
import { PrismaClient, Role, AccountType, BeneficiaryStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// rupees (as a number, may include paise) -> BigInt paise
const paise = (rupees: number): bigint => BigInt(Math.round(rupees * 100));

// Demo credentials — fine to hardcode for a local simulator, never real.
const LOGIN_PASSWORD = 'Finspark@123';
const TXN_PASSWORD = 'Txn@12345';

async function main(): Promise<void> {
  const loginHash = await bcrypt.hash(LOGIN_PASSWORD, 10);
  const txnHash = await bcrypt.hash(TXN_PASSWORD, 10);

  // --- Customer -----------------------------------------------------------
  const customer = await prisma.customer.upsert({
    where: { customerId: '83840226' },
    update: {},
    create: {
      customerId: '83840226',
      name: 'Vantage Textiles Pvt Ltd',
      status: 'ACTIVE',
      // Fabricated profile signals for the Sentinel model (Step 8).
      customerAge: 42,
      incomeBand: 0.72,
    },
  });

  // --- Users (3) ----------------------------------------------------------
  const userSpecs = [
    { userId: 'TARAKESH', mobile: '9820011234', email: 'tarakesh@vantage-demo.in', role: Role.MAKER },
    { userId: 'PRIYA_A', mobile: '9820022345', email: 'priya@vantage-demo.in', role: Role.AUTHORIZER },
    { userId: 'ROHIT_V', mobile: '9820033456', email: 'rohit@vantage-demo.in', role: Role.VIEWER },
  ];

  for (const spec of userSpecs) {
    const user = await prisma.user.upsert({
      where: { userId: spec.userId },
      update: {},
      create: {
        userId: spec.userId,
        passwordHash: loginHash,
        txnPasswordHash: txnHash,
        mobile: spec.mobile,
        email: spec.email,
        status: 'ACTIVE',
      },
    });
    await prisma.customerUser.upsert({
      where: { customerId_userId: { customerId: customer.id, userId: user.id } },
      update: { role: spec.role },
      create: { customerId: customer.id, userId: user.id, role: spec.role },
    });
    await prisma.passwordHistory.createMany({
      data: [
        { userId: user.id, passwordHash: loginHash, kind: 'LOGIN' },
        { userId: user.id, passwordHash: txnHash, kind: 'TXN' },
      ],
      skipDuplicates: true,
    });
  }

  // --- Accounts (2) -------------------------------------------------------
  const accountSpecs = [
    {
      accountNumber: '201000401234',
      accountName: 'Vantage Textiles - Current',
      accountType: AccountType.CURRENT,
      schemeType: 'CAA',
      clearBalance: paise(7220196.5), // ₹72,20,196.50
      fundsInClearing: paise(150000),
      holdAmount: paise(0),
      fdBalance: paise(0),
    },
    {
      accountNumber: '201000405678',
      accountName: 'Vantage Textiles - Savings',
      accountType: AccountType.SAVINGS,
      schemeType: 'SBA',
      clearBalance: paise(460000), // ₹4,60,000.00
      fundsInClearing: paise(0),
      holdAmount: paise(25000),
      fdBalance: paise(1000000), // ₹10,00,000 linked FD
    },
  ];

  for (const spec of accountSpecs) {
    await prisma.account.upsert({
      where: { accountNumber: spec.accountNumber },
      update: {},
      create: { customerId: customer.id, currency: 'INR', ...spec },
    });
  }

  // --- Beneficiaries (8) --------------------------------------------------
  const now = Date.now();
  const minsAgo = (m: number): Date => new Date(now - m * 60_000);

  const beneSpecs = [
    // aged, active, own-bank IFT — scenario 1 (LOW)
    { code: 'BEN001', name: 'Sunrise Fabrics', accountNumber: '201000409999', ifsc: null, isOwnBank: true, rails: { allowIFT: true }, status: BeneficiaryStatus.ACTIVE, activatedAt: minsAgo(60 * 24 * 40), state: 'Maharashtra', city: 'Mumbai' },
    { code: 'BEN002', name: 'Kumar Yarns Pvt Ltd', accountNumber: '5011234567890', ifsc: 'HDFC0000123', isOwnBank: false, rails: { allowNEFT: true, allowRTGS: true }, status: BeneficiaryStatus.ACTIVE, activatedAt: minsAgo(60 * 24 * 30), state: 'Gujarat', city: 'Surat' },
    { code: 'BEN003', name: 'Deccan Dyes', accountNumber: '3012345678901', ifsc: 'ICIC0000456', isOwnBank: false, rails: { allowIMPS: true, allowNEFT: true }, status: BeneficiaryStatus.ACTIVE, activatedAt: minsAgo(60 * 24 * 12), state: 'Telangana', city: 'Hyderabad' },
    { code: 'BEN004', name: 'Ganesh Logistics', accountNumber: '6023456789012', ifsc: 'SBIN0000789', isOwnBank: false, rails: { allowNEFT: true, allowRTGS: true, allowIMPS: true }, status: BeneficiaryStatus.ACTIVE, activatedAt: minsAgo(60 * 24 * 5), state: 'Karnataka', city: 'Bengaluru' },
    // recently activated (cooling period) — scenario 2 (MEDIUM/HIGH)
    { code: 'BEN005', name: 'Nova Traders', accountNumber: '7034567890123', ifsc: 'AXIS0000321', isOwnBank: false, rails: { allowRTGS: true, allowNEFT: true }, status: BeneficiaryStatus.ACTIVE, activatedAt: minsAgo(5), state: 'Delhi', city: 'New Delhi' },
    // pending (not usable for transfers)
    { code: 'BEN006', name: 'Meghna Exports', accountNumber: '8045678901234', ifsc: 'PUNB0000654', isOwnBank: false, rails: { allowNEFT: true }, status: BeneficiaryStatus.PENDING, activatedAt: null, state: 'West Bengal', city: 'Kolkata' },
    { code: 'BEN007', name: 'Anand Steels', accountNumber: '9056789012345', ifsc: 'KKBK0000987', isOwnBank: false, rails: { allowRTGS: true }, status: BeneficiaryStatus.PENDING, activatedAt: null, state: 'Tamil Nadu', city: 'Chennai' },
    // rejected
    { code: 'BEN008', name: 'Zenith Chemicals', accountNumber: '1067890123456', ifsc: 'YESB0000246', isOwnBank: false, rails: { allowIMPS: true }, status: BeneficiaryStatus.REJECTED, activatedAt: null, state: 'Rajasthan', city: 'Jaipur' },
  ];

  for (const b of beneSpecs) {
    await prisma.beneficiary.upsert({
      where: { customerId_code: { customerId: customer.id, code: b.code } },
      update: {},
      create: {
        customerId: customer.id,
        code: b.code,
        name: b.name,
        nameAsFetched: b.status === BeneficiaryStatus.ACTIVE ? b.name : null,
        accountNumber: b.accountNumber,
        ifsc: b.ifsc,
        isOwnBank: b.isOwnBank,
        allowIFT: b.rails.allowIFT ?? false,
        allowRTGS: b.rails.allowRTGS ?? false,
        allowNEFT: b.rails.allowNEFT ?? false,
        allowIMPS: b.rails.allowIMPS ?? false,
        state: b.state,
        city: b.city,
        pinCode: '400001',
        status: b.status,
        createdBy: 'TARAKESH',
        activatedBy: b.status === BeneficiaryStatus.ACTIVE ? 'PRIYA_A' : null,
        activatedAt: b.activatedAt,
      },
    });
  }

  // --- Historical transactions (statement/mini-statement data) ------------
  const currentAccount = await prisma.account.findUnique({
    where: { accountNumber: '201000401234' },
  });
  const activeBenes = await prisma.beneficiary.findMany({
    where: { customerId: customer.id, status: 'ACTIVE' },
    take: 3,
  });

  if (currentAccount && (await prisma.ledgerEntry.count({ where: { accountId: currentAccount.id } })) === 0) {
    const daysAgo = (d: number): Date => new Date(now - d * 24 * 60 * 60_000);
    // Running balance ends at the seeded clearBalance; we walk backwards from it.
    let balance = currentAccount.clearBalance;

    // Each tuple: [daysAgo, direction, amountRupees, description, riskLevel?]
    const history: Array<[number, 'CREDIT' | 'DEBIT', number, string, ('LOW' | 'MEDIUM' | 'HIGH') | null]> = [
      [1, 'DEBIT', 125000, 'NEFT to Kumar Yarns Pvt Ltd', 'LOW'],
      [2, 'CREDIT', 450000, 'Inward RTGS - Sunrise Fabrics', null],
      [4, 'DEBIT', 89000, 'IMPS to Deccan Dyes', 'LOW'],
      [6, 'DEBIT', 1800000, 'RTGS to Nova Traders', 'MEDIUM'],
      [9, 'CREDIT', 1200000, 'Customer collection - GST refund', null],
      [12, 'DEBIT', 47500, 'NEFT to Ganesh Logistics', 'LOW'],
      [18, 'CREDIT', 300000, 'Inward IMPS', null],
      [25, 'DEBIT', 260000, 'RTGS to Kumar Yarns Pvt Ltd', 'LOW'],
    ];

    // Optionally back a few debits with a completed Payment so a risk badge shows.
    let serial = 1;
    for (const [d, direction, rupees, desc, risk] of history) {
      const amount = BigInt(Math.round(rupees * 100));
      const balanceAfter = balance;
      // Walk the pre-transaction balance backwards for the next (older) row.
      balance = direction === 'DEBIT' ? balance + amount : balance - amount;

      let paymentId: string | undefined;
      if (direction === 'DEBIT' && risk && activeBenes.length) {
        const bene = activeBenes[serial % activeBenes.length];
        const dd = String(daysAgo(d).getDate()).padStart(2, '0');
        const mm = String(daysAgo(d).getMonth() + 1).padStart(2, '0');
        const yyyy = daysAgo(d).getFullYear();
        const payment = await prisma.payment.create({
          data: {
            refNo: `GX${dd}${mm}${yyyy}${String(serial).padStart(6, '0')}`,
            custRefNo: `SEEDREF${serial}`,
            customerId: customer.id,
            debitAccountId: currentAccount.id,
            beneficiaryId: bene.id,
            amount,
            amountInWords: `${rupees} rupees`,
            rail: 'NEFT',
            paymentMode: 'Fund Transfer - Other Bank (NEFT)',
            status: 'COMPLETED',
            riskScore: risk === 'MEDIUM' ? 0.42 : 0.08,
            riskLevel: risk,
            initiatedBy: 'TARAKESH',
            postedAt: daysAgo(d),
            valueDate: daysAgo(d),
          },
        });
        paymentId = payment.id;
        serial++;
      }

      await prisma.ledgerEntry.create({
        data: {
          accountId: currentAccount.id,
          paymentId,
          direction,
          amount,
          balanceAfter,
          description: desc,
          postedAt: daysAgo(d),
          valueDate: daysAgo(d),
        },
      });
    }
  }

  const counts = {
    customers: await prisma.customer.count(),
    users: await prisma.user.count(),
    accounts: await prisma.account.count(),
    beneficiaries: await prisma.beneficiary.count(),
    ledgerEntries: await prisma.ledgerEntry.count(),
  };
  // eslint-disable-next-line no-console
  console.log('Seed complete:', counts);
  // eslint-disable-next-line no-console
  console.log(`Demo login: Customer 83840226 / User TARAKESH / Password ${LOGIN_PASSWORD}`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
