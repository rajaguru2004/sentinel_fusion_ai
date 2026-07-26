/**
 * FinSpark — Comprehensive Demo Seed
 * Covers all 14 Prisma models with rich fabricated data.
 * Designed to showcase every feature: payments, fraud gateway,
 * analyst feed, disputes, cases, ledger, beneficiaries, audit trail.
 *
 * Idempotent — safe to re-run. All data is fabricated per spec §14.
 */
try {
  process.loadEnvFile?.();
} catch {
  // ignore
}

import {
  PrismaClient,
  Prisma,
  Role,
  AccountType,
  BeneficiaryStatus,
  PaymentStatus,
  RiskLevel,
  LedgerDirection,
  CaseSource,
  CaseStatus,
  Rail,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const paise = (rupees: number): bigint => BigInt(Math.round(rupees * 100));

const LOGIN_PASSWORD = 'Finspark@123';
const TXN_PASSWORD = 'Txn@12345';

const now = Date.now();
const daysAgo = (d: number): Date => new Date(now - d * 86_400_000);
const minsAgo = (m: number): Date => new Date(now - m * 60_000);
const hoursAgo = (h: number): Date => new Date(now - h * 3_600_000);

async function main(): Promise<void> {
  const loginHash = await bcrypt.hash(LOGIN_PASSWORD, 10);
  const txnHash = await bcrypt.hash(TXN_PASSWORD, 10);

  // ─── 1. CUSTOMER ────────────────────────────────────────────────────────────
  const customer = await prisma.customer.upsert({
    where: { customerId: '83840226' },
    update: { name: 'Vantage Textiles Pvt Ltd', customerAge: 42, incomeBand: 0.72 },
    create: {
      customerId: '83840226',
      name: 'Vantage Textiles Pvt Ltd',
      status: 'ACTIVE',
      customerAge: 42,
      incomeBand: 0.72,
    },
  });

  // ─── 2. USERS (3 roles) ──────────────────────────────────────────────────────
  const userSpecs = [
    { userId: 'TARAKESH', mobile: '9820011234', email: 'tarakesh@vantage-demo.in', role: Role.MAKER },
    { userId: 'PRIYA_A',  mobile: '9820022345', email: 'priya@vantage-demo.in',    role: Role.AUTHORIZER },
    { userId: 'ROHIT_V',  mobile: '9820033456', email: 'rohit@vantage-demo.in',    role: Role.VIEWER },
  ];

  const userMap: Record<string, string> = {};
  for (const spec of userSpecs) {
    const user = await prisma.user.upsert({
      where: { userId: spec.userId },
      update: { mobile: spec.mobile, email: spec.email, lastLoginAt: daysAgo(0) },
      create: {
        userId: spec.userId,
        passwordHash: loginHash,
        txnPasswordHash: txnHash,
        mobile: spec.mobile,
        email: spec.email,
        status: 'ACTIVE',
        lastLoginAt: daysAgo(0),
      },
    });
    userMap[spec.userId] = user.id;
    await prisma.customerUser.upsert({
      where: { customerId_userId: { customerId: customer.id, userId: user.id } },
      update: { role: spec.role },
      create: { customerId: customer.id, userId: user.id, role: spec.role },
    });
    await prisma.passwordHistory.createMany({
      data: [
        { userId: user.id, passwordHash: loginHash, kind: 'LOGIN' },
        { userId: user.id, passwordHash: txnHash,   kind: 'TXN' },
      ],
      skipDuplicates: true,
    });
  }

  // ─── 3. ACCOUNTS (3) ─────────────────────────────────────────────────────────
  const accountSpecs = [
    {
      accountNumber: '201000401234',
      accountName: 'Vantage Textiles - Current',
      accountType: AccountType.CURRENT,
      schemeType: 'CAA',
      clearBalance: paise(7_220_196.50),
      fundsInClearing: paise(1_50_000),
      holdAmount: paise(50_000),
      fdBalance: paise(0),
    },
    {
      accountNumber: '201000405678',
      accountName: 'Vantage Textiles - Savings',
      accountType: AccountType.SAVINGS,
      schemeType: 'SBA',
      clearBalance: paise(4_60_000),
      fundsInClearing: paise(0),
      holdAmount: paise(25_000),
      fdBalance: paise(10_00_000),
    },
    {
      accountNumber: '201000409012',
      accountName: 'Vantage Textiles - FD Linked',
      accountType: AccountType.FD_TD,
      schemeType: 'FD',
      clearBalance: paise(0),
      fundsInClearing: paise(0),
      holdAmount: paise(0),
      fdBalance: paise(50_00_000),
    },
  ];

  for (const spec of accountSpecs) {
    await prisma.account.upsert({
      where: { accountNumber: spec.accountNumber },
      update: { clearBalance: spec.clearBalance, holdAmount: spec.holdAmount, fdBalance: spec.fdBalance },
      create: { customerId: customer.id, currency: 'INR', ...spec },
    });
  }

  const currentAccount = await prisma.account.findUniqueOrThrow({ where: { accountNumber: '201000401234' } });
  const savingsAccount = await prisma.account.findUniqueOrThrow({ where: { accountNumber: '201000405678' } });

  // ─── 4. BENEFICIARIES (15) ───────────────────────────────────────────────────
  const beneSpecs = [
    // Long-standing, trusted — drives LOW risk demo
    { code: 'BEN001', name: 'Sunrise Fabrics Ltd',       accountNumber: '201000409999', ifsc: null,         isOwnBank: true,  rails: { allowIFT: true },                             status: BeneficiaryStatus.ACTIVE,   activatedAt: daysAgo(45), state: 'Maharashtra', city: 'Mumbai',     pinCode: '400001' },
    { code: 'BEN002', name: 'Kumar Yarns Pvt Ltd',        accountNumber: '50112345678901', ifsc: 'HDFC0000123', isOwnBank: false, rails: { allowNEFT: true, allowRTGS: true },          status: BeneficiaryStatus.ACTIVE,   activatedAt: daysAgo(30), state: 'Gujarat',     city: 'Surat',      pinCode: '395001' },
    { code: 'BEN003', name: 'Deccan Dyes & Chemicals',    accountNumber: '30123456789012', ifsc: 'ICIC0000456', isOwnBank: false, rails: { allowIMPS: true, allowNEFT: true },          status: BeneficiaryStatus.ACTIVE,   activatedAt: daysAgo(20), state: 'Telangana',  city: 'Hyderabad',  pinCode: '500001' },
    { code: 'BEN004', name: 'Ganesh Logistics Pvt Ltd',   accountNumber: '60234567890123', ifsc: 'SBIN0000789', isOwnBank: false, rails: { allowNEFT: true, allowRTGS: true, allowIMPS: true }, status: BeneficiaryStatus.ACTIVE, activatedAt: daysAgo(15), state: 'Karnataka',  city: 'Bengaluru',  pinCode: '560001' },
    { code: 'BEN005', name: 'Meghna Exports Pvt Ltd',     accountNumber: '80456789012345', ifsc: 'PUNB0000654', isOwnBank: false, rails: { allowNEFT: true, allowRTGS: true },          status: BeneficiaryStatus.ACTIVE,   activatedAt: daysAgo(10), state: 'West Bengal', city: 'Kolkata',    pinCode: '700001' },
    // Recently activated (< 30 min cooling) — drives HIGH/MEDIUM risk
    { code: 'BEN006', name: 'Nova Traders International', accountNumber: '70345678901234', ifsc: 'AXIS0000321', isOwnBank: false, rails: { allowRTGS: true, allowNEFT: true },          status: BeneficiaryStatus.ACTIVE,   activatedAt: minsAgo(10), state: 'Delhi',       city: 'New Delhi',  pinCode: '110001' },
    // Name-mismatch bene (fetched name differs) — fraud signal
    { code: 'BEN007', name: 'Rajesh Kumar Trading Co',    accountNumber: '90567890123456', ifsc: 'KKBK0000987', isOwnBank: false, rails: { allowNEFT: true, allowIMPS: true },          status: BeneficiaryStatus.ACTIVE,   activatedAt: daysAgo(8),  state: 'Tamil Nadu', city: 'Chennai',    pinCode: '600001' },
    // High-value RTGS bene
    { code: 'BEN008', name: 'IndoGulf Petrochemicals',    accountNumber: '11678901234567', ifsc: 'YESB0000246', isOwnBank: false, rails: { allowRTGS: true },                           status: BeneficiaryStatus.ACTIVE,   activatedAt: daysAgo(25), state: 'Gujarat',     city: 'Vadodara',   pinCode: '390001' },
    { code: 'BEN009', name: 'Anand Steel Works Ltd',      accountNumber: '12789012345678', ifsc: 'BARB0000111', isOwnBank: false, rails: { allowNEFT: true, allowRTGS: true },          status: BeneficiaryStatus.ACTIVE,   activatedAt: daysAgo(35), state: 'Jharkhand',  city: 'Jamshedpur', pinCode: '831001' },
    { code: 'BEN010', name: 'Bharat Thread Mills',        accountNumber: '13890123456789', ifsc: 'CNRB0000222', isOwnBank: false, rails: { allowIMPS: true, allowNEFT: true },          status: BeneficiaryStatus.ACTIVE,   activatedAt: daysAgo(60), state: 'Rajasthan',  city: 'Jaipur',     pinCode: '302001' },
    // PENDING — not usable, shows in maintenance list
    { code: 'BEN011', name: 'Zenith Chemicals Ltd',       accountNumber: '14901234567890', ifsc: 'UTIB0000333', isOwnBank: false, rails: { allowIMPS: true },                           status: BeneficiaryStatus.PENDING,  activatedAt: null,        state: 'Haryana',    city: 'Gurugram',   pinCode: '122001' },
    { code: 'BEN012', name: 'Pacific Poly Films',         accountNumber: '15012345678901', ifsc: 'HDFC0000444', isOwnBank: false, rails: { allowNEFT: true },                           status: BeneficiaryStatus.PENDING,  activatedAt: null,        state: 'Andhra Pradesh', city: 'Visakhapatnam', pinCode: '530001' },
    // REJECTED — shows in list as rejected
    { code: 'BEN013', name: 'Phantom Ventures',           accountNumber: '16123456789012', ifsc: 'ICIC0000555', isOwnBank: false, rails: { allowRTGS: true },                           status: BeneficiaryStatus.REJECTED, activatedAt: null,        state: 'Maharashtra', city: 'Pune',       pinCode: '411001' },
    // Domestic IMPS specialists
    { code: 'BEN014', name: 'Lakshmi Cotton Ginning',     accountNumber: '17234567890123', ifsc: 'SBIN0000666', isOwnBank: false, rails: { allowIMPS: true, allowNEFT: true },          status: BeneficiaryStatus.ACTIVE,   activatedAt: daysAgo(18), state: 'Maharashtra', city: 'Nagpur',     pinCode: '440001' },
    { code: 'BEN015', name: 'Eastern Silk Traders',       accountNumber: '18345678901234', ifsc: 'UCBA0000777', isOwnBank: false, rails: { allowNEFT: true },                           status: BeneficiaryStatus.ACTIVE,   activatedAt: daysAgo(50), state: 'Assam',       city: 'Guwahati',   pinCode: '781001' },
  ];

  for (const b of beneSpecs) {
    // For name-mismatch demo: BEN007 has a different fetched name
    const nameAsFetched = b.status === BeneficiaryStatus.ACTIVE
      ? (b.code === 'BEN007' ? 'R. Kumar Traders (Disputed)' : b.name)
      : null;

    await prisma.beneficiary.upsert({
      where: { customerId_code: { customerId: customer.id, code: b.code } },
      update: { status: b.status, activatedAt: b.activatedAt },
      create: {
        customerId: customer.id,
        code: b.code,
        name: b.name,
        nameAsFetched,
        accountNumber: b.accountNumber,
        ifsc: b.ifsc,
        isOwnBank: b.isOwnBank,
        allowIFT:  b.rails.allowIFT  ?? false,
        allowRTGS: b.rails.allowRTGS ?? false,
        allowNEFT: b.rails.allowNEFT ?? false,
        allowIMPS: b.rails.allowIMPS ?? false,
        state: b.state,
        city: b.city,
        pinCode: b.pinCode,
        status: b.status,
        createdBy: 'TARAKESH',
        activatedBy: b.status === BeneficiaryStatus.ACTIVE ? 'PRIYA_A' : null,
        activatedAt: b.activatedAt,
      },
    });
  }

  const benes = await prisma.beneficiary.findMany({ where: { customerId: customer.id } });
  const beneByCode = Object.fromEntries(benes.map((b) => [b.code, b]));

  // ─── 5. PAYMENTS + FRAUD EVENTS + LEDGER (rich history) ─────────────────────
  // Only seed if ledger is empty (idempotency)
  const existingLedger = await prisma.ledgerEntry.count({ where: { accountId: currentAccount.id } });
  if (existingLedger === 0) {

    type PaymentRow = {
      d: number; // days ago
      amount: number;
      rail: Rail;
      beneCode: string;
      status: PaymentStatus;
      riskScore: number;
      riskLevel: RiskLevel | null;
      decision: string;
      remarks?: string;
      serial: string;
    };

    const paymentRows: PaymentRow[] = [
      // --- COMPLETED LOW risk payments (normal business) ---
      { d: 1,  amount: 1_25_000,    rail: 'NEFT',  beneCode: 'BEN002', status: 'COMPLETED', riskScore: 0.06, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Monthly yarn supply payment', serial: '000001' },
      { d: 2,  amount: 89_000,      rail: 'IMPS',  beneCode: 'BEN003', status: 'COMPLETED', riskScore: 0.09, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Dye batch #47 invoice', serial: '000002' },
      { d: 3,  amount: 47_500,      rail: 'NEFT',  beneCode: 'BEN004', status: 'COMPLETED', riskScore: 0.04, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Logistics Q3 bill', serial: '000003' },
      { d: 5,  amount: 2_60_000,    rail: 'RTGS',  beneCode: 'BEN002', status: 'COMPLETED', riskScore: 0.11, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Bulk yarn order Jul 2026', serial: '000004' },
      { d: 7,  amount: 75_000,      rail: 'IMPS',  beneCode: 'BEN010', status: 'COMPLETED', riskScore: 0.07, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Thread mill restocking', serial: '000005' },
      { d: 9,  amount: 3_80_000,    rail: 'NEFT',  beneCode: 'BEN005', status: 'COMPLETED', riskScore: 0.13, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Export clearance fees', serial: '000006' },
      { d: 10, amount: 1_10_000,    rail: 'NEFT',  beneCode: 'BEN009', status: 'COMPLETED', riskScore: 0.08, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Steel frame parts', serial: '000007' },
      { d: 12, amount: 55_000,      rail: 'IMPS',  beneCode: 'BEN014', status: 'COMPLETED', riskScore: 0.05, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Cotton ginning charges', serial: '000008' },
      { d: 14, amount: 4_25_000,    rail: 'RTGS',  beneCode: 'BEN008', status: 'COMPLETED', riskScore: 0.12, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Petrochem monthly contract', serial: '000009' },
      { d: 15, amount: 92_000,      rail: 'NEFT',  beneCode: 'BEN015', status: 'COMPLETED', riskScore: 0.06, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Silk supply Sept 2026', serial: '000010' },
      { d: 18, amount: 2_10_000,    rail: 'NEFT',  beneCode: 'BEN003', status: 'COMPLETED', riskScore: 0.09, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Dye batch #51 advance', serial: '000011' },
      { d: 20, amount: 5_50_000,    rail: 'RTGS',  beneCode: 'BEN002', status: 'COMPLETED', riskScore: 0.14, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Annual yarn contract Q3', serial: '000012' },
      // IFT (own bank)
      { d: 22, amount: 1_00_000,    rail: 'IFT',   beneCode: 'BEN001', status: 'COMPLETED', riskScore: 0.03, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'Internal fund transfer', serial: '000013' },

      // --- MEDIUM risk — challenged, then completed ---
      { d: 4,  amount: 18_00_000,   rail: 'RTGS',  beneCode: 'BEN006', status: 'COMPLETED', riskScore: 0.38, riskLevel: 'MEDIUM', decision: 'CHALLENGE', remarks: 'Urgent supplier payment - Nova Traders', serial: '000014' },
      { d: 6,  amount: 7_50_000,    rail: 'NEFT',  beneCode: 'BEN007', status: 'COMPLETED', riskScore: 0.44, riskLevel: 'MEDIUM', decision: 'CHALLENGE', remarks: 'Rajesh Kumar trading Feb payment', serial: '000015' },
      { d: 8,  amount: 5_20_000,    rail: 'RTGS',  beneCode: 'BEN005', status: 'COMPLETED', riskScore: 0.41, riskLevel: 'MEDIUM', decision: 'CHALLENGE', remarks: 'Export docs processing fee', serial: '000016' },

      // --- HIGH risk — currently HELD (analyst action pending) ---
      { d: 0,  amount: 25_00_000,   rail: 'RTGS',  beneCode: 'BEN006', status: 'HELD',      riskScore: 0.68, riskLevel: 'HIGH',   decision: 'HOLD',      remarks: 'Large RTGS to recently activated bene', serial: '000017' },
      { d: 1,  amount: 12_00_000,   rail: 'RTGS',  beneCode: 'BEN007', status: 'HELD',      riskScore: 0.71, riskLevel: 'HIGH',   decision: 'HOLD',      remarks: 'Name mismatch detected on beneficiary', serial: '000018' },

      // --- CRITICAL — BLOCKED, account frozen, case opened ---
      { d: 2,  amount: 45_00_000,   rail: 'RTGS',  beneCode: 'BEN006', status: 'BLOCKED',   riskScore: 0.88, riskLevel: 'CRITICAL', decision: 'BLOCK',   remarks: 'Velocity spike + new country + high amount', serial: '000019' },

      // --- Cutoff HELD (value-dated) ---
      { d: 0,  amount: 30_00_000,   rail: 'RTGS',  beneCode: 'BEN008', status: 'HELD',      riskScore: 0.10, riskLevel: 'LOW',    decision: 'EXECUTE',   remarks: 'After-hours RTGS — value dated next working day', serial: '000020' },

      // --- Older completed for full statement ---
      { d: 25, amount: 1_85_000,    rail: 'NEFT',  beneCode: 'BEN004', status: 'COMPLETED', riskScore: 0.07, riskLevel: 'LOW',    decision: 'EXECUTE',   serial: '000021' },
      { d: 27, amount: 63_000,      rail: 'IMPS',  beneCode: 'BEN003', status: 'COMPLETED', riskScore: 0.05, riskLevel: 'LOW',    decision: 'EXECUTE',   serial: '000022' },
      { d: 30, amount: 8_90_000,    rail: 'RTGS',  beneCode: 'BEN009', status: 'COMPLETED', riskScore: 0.16, riskLevel: 'LOW',    decision: 'EXECUTE',   serial: '000023' },
    ];

    // Running balance for double-entry (walk backwards from current)
    let runningBalance = currentAccount.clearBalance;

    for (const row of paymentRows) {
      const dateStr = daysAgo(row.d);
      const dd = String(dateStr.getDate()).padStart(2, '0');
      const mm = String(dateStr.getMonth() + 1).padStart(2, '0');
      const yyyy = dateStr.getFullYear();
      const refNo = `GX${dd}${mm}${yyyy}${row.serial}`;
      const bene = beneByCode[row.beneCode];
      if (!bene) continue;

      // Skip duplicate refNo
      const exists = await prisma.payment.findUnique({ where: { refNo } });
      if (exists) continue;

      const amount = paise(row.amount);
      const railLabel: Record<Rail, string> = { IFT: 'Fund Transfer - Own Bank (IFT)', IMPS: 'Fund Transfer - IMPS', NEFT: 'Fund Transfer - NEFT', RTGS: 'Fund Transfer - RTGS' };

      const payment = await prisma.payment.create({
        data: {
          refNo,
          custRefNo: `CREF${row.serial}`,
          customerId: customer.id,
          debitAccountId: currentAccount.id,
          beneficiaryId: bene.id,
          amount,
          amountInWords: `${row.amount.toLocaleString('en-IN')} Rupees`,
          rail: row.rail,
          paymentMode: railLabel[row.rail],
          status: row.status,
          riskScore: row.riskScore,
          riskLevel: row.riskLevel,
          remarks: row.remarks,
          initiatedBy: 'TARAKESH',
          reviewApproved: false,
          valueDate: dateStr,
          postedAt: row.status === 'COMPLETED' ? dateStr : null,
          createdAt: dateStr,
          updatedAt: dateStr,
          riskReasons: (() => {
            if (!row.riskLevel || row.riskLevel === 'LOW') return Prisma.JsonNull;
            const reasons: object[] = [
              { code: 'BENE_COOLING', label: 'Beneficiary activated < 30 min ago', weight: 0.28 },
            ];
            if (row.riskLevel === 'HIGH' || row.riskLevel === 'CRITICAL') {
              reasons.push({ code: 'AMOUNT_ANOMALY', label: 'Amount 8x customer mean transaction', weight: 0.22 });
            }
            if (row.riskLevel === 'CRITICAL') {
              reasons.push({ code: 'VELOCITY_SPIKE', label: 'Velocity spike — 3x above 30-day mean', weight: 0.34 });
              reasons.push({ code: 'NEW_COUNTRY', label: 'First login from country: SG', weight: 0.18 });
            }
            return reasons;
          })(),
        },
      });

      // Fraud event for every scored payment
      await prisma.fraudEvent.create({
        data: {
          eventId: `pay:${payment.id}`,
          paymentId: payment.id,
          userId: userMap['TARAKESH'],
          eventType: 'PAYMENT_INITIATE',
          riskScore: row.riskScore,
          riskLevel: row.riskLevel ?? 'LOW',
          decision: row.decision,
          ip: '203.192.42.10',
          deviceFingerprint: 'fp_demo_desktop_chrome',
          modelScores: { heuristic: row.riskScore, sentinel: row.riskScore * 0.97 },
          shapReasons: row.riskLevel && row.riskLevel !== 'LOW'
            ? [
                { feature: 'amount_vs_mean', value: row.riskScore > 0.6 ? 3.8 : 1.9, contribution: 0.18 },
                { feature: 'bene_age_days',  value: row.beneCode === 'BEN006' ? 0.1 : 12,  contribution: 0.24 },
              ]
            : [{ feature: 'amount_vs_mean', value: 0.8, contribution: 0.04 }],
          createdAt: dateStr,
        },
      });

      // Ledger entry only for completed payments
      if (row.status === 'COMPLETED') {
        const balanceAfter = runningBalance;
        runningBalance += amount; // walk backwards
        await prisma.ledgerEntry.create({
          data: {
            accountId: currentAccount.id,
            paymentId: payment.id,
            direction: LedgerDirection.DEBIT,
            amount,
            balanceAfter,
            description: `${row.rail} to ${bene.name}${row.remarks ? ' — ' + row.remarks : ''}`,
            valueDate: dateStr,
            postedAt: dateStr,
          },
        });
      }
    }

    // Inward credits (no payment record — external remittances)
    const credits: Array<{ d: number; rupees: number; desc: string }> = [
      { d: 2,  rupees: 4_50_000,   desc: 'Inward RTGS — Sunrise Fabrics Q3 payment' },
      { d: 5,  rupees: 12_00_000,  desc: 'Customer collection — GST refund GOI' },
      { d: 8,  rupees: 3_00_000,   desc: 'Inward IMPS — Rajasthan textile board grant' },
      { d: 13, rupees: 6_75_000,   desc: 'Inward RTGS — IndoGulf advance payment' },
      { d: 19, rupees: 2_20_000,   desc: 'Inward NEFT — Eastern Silk receivable' },
      { d: 24, rupees: 9_80_000,   desc: 'Inward RTGS — Sunrise Fabrics annual settlement' },
      { d: 28, rupees: 1_50_000,   desc: 'NACH credit — Subsidy disbursement' },
    ];

    for (const c of credits) {
      const dateStr = daysAgo(c.d);
      const amount = paise(c.rupees);
      const balanceAfter = runningBalance;
      runningBalance -= amount;
      await prisma.ledgerEntry.create({
        data: {
          accountId: currentAccount.id,
          direction: LedgerDirection.CREDIT,
          amount,
          balanceAfter,
          description: c.desc,
          valueDate: dateStr,
          postedAt: dateStr,
        },
      });
    }

    // Savings account mini-statement entries
    const savingsCredits = [
      { d: 3,  rupees: 50_000,  desc: 'Transfer from Current Account — IFT' },
      { d: 10, rupees: 25_000,  desc: 'Interest credit Q2 2026' },
      { d: 17, rupees: 75_000,  desc: 'Transfer from Current Account — IFT' },
    ];
    let savBal = savingsAccount.clearBalance;
    for (const s of savingsCredits) {
      await prisma.ledgerEntry.create({
        data: {
          accountId: savingsAccount.id,
          direction: LedgerDirection.CREDIT,
          amount: paise(s.rupees),
          balanceAfter: savBal,
          description: s.desc,
          valueDate: daysAgo(s.d),
          postedAt: daysAgo(s.d),
        },
      });
      savBal -= paise(s.rupees);
    }
  }

  // ─── 6. CASES (3) ────────────────────────────────────────────────────────────
  // Case 1: AI-flagged CRITICAL payment — OPEN
  const blockedPayment = await prisma.payment.findFirst({
    where: { customerId: customer.id, status: 'BLOCKED' },
  });
  if (blockedPayment) {
    const c1 = await prisma.case.upsert({
      where: { trackingRef: 'CASE-2026-0001' },
      update: {},
      create: {
        trackingRef: 'CASE-2026-0001',
        customerId: customer.id,
        paymentId: blockedPayment.id,
        source: CaseSource.AI_FLAGGED,
        fraudType: 'ACCOUNT_TAKEOVER',
        amount: blockedPayment.amount,
        status: CaseStatus.IN_REVIEW,
        assignedTo: 'PRIYA_A',
        createdAt: daysAgo(2),
        updatedAt: daysAgo(1),
      },
    });
    await prisma.caseNote.createMany({
      data: [
        { caseId: c1.id, authorId: 'SYSTEM', body: 'Case auto-opened by AI fraud engine. Risk score 0.88 — CRITICAL. Payment blocked. Account flagged for review.', createdAt: daysAgo(2) },
        { caseId: c1.id, authorId: 'PRIYA_A', body: 'Contacted customer via registered mobile. Customer confirmed they did NOT initiate this payment. Escalating to fraud team.', createdAt: daysAgo(1) },
        { caseId: c1.id, authorId: 'PRIYA_A', body: 'Fraud confirmed. Payment permanently blocked. Initiating account freeze protocol.', createdAt: hoursAgo(6) },
      ],
      skipDuplicates: true,
    });
  }

  // Case 2: Customer-reported dispute — OPEN
  const heldPayment = await prisma.payment.findFirst({
    where: { customerId: customer.id, status: 'HELD' },
  });
  if (heldPayment) {
    const c2 = await prisma.case.upsert({
      where: { trackingRef: 'CASE-2026-0002' },
      update: {},
      create: {
        trackingRef: 'CASE-2026-0002',
        customerId: customer.id,
        paymentId: heldPayment.id,
        source: CaseSource.CUSTOMER_REPORTED,
        fraudType: 'SUSPICIOUS_HOLD',
        amount: heldPayment.amount,
        status: CaseStatus.OPEN,
        assignedTo: 'PRIYA_A',
        createdAt: daysAgo(0),
        updatedAt: daysAgo(0),
      },
    });
    await prisma.caseNote.createMany({
      data: [
        { caseId: c2.id, authorId: 'TARAKESH', body: 'Payment was held by fraud engine. Amount is a genuine vendor payment to IndoGulf Petrochemicals. Requesting analyst review.', createdAt: hoursAgo(3) },
        { caseId: c2.id, authorId: 'PRIYA_A',  body: 'Reviewing transaction details. Vendor relationship established 25 days ago. Amount consistent with contract. Will process release.', createdAt: hoursAgo(1) },
      ],
      skipDuplicates: true,
    });
  }

  // Case 3: Grievance — RESOLVED
  const c3 = await prisma.case.upsert({
    where: { trackingRef: 'CASE-2026-0003' },
    update: {},
    create: {
      trackingRef: 'CASE-2026-0003',
      customerId: customer.id,
      source: CaseSource.CUSTOMER_REPORTED,
      fraudType: 'SERVICE_COMPLAINT',
      amount: null,
      status: CaseStatus.RESOLVED,
      assignedTo: 'ROHIT_V',
      resolution: 'Technical glitch confirmed. OTP delivery delay resolved. Customer compensated with waived transaction fee.',
      createdAt: daysAgo(7),
      updatedAt: daysAgo(5),
    },
  });
  await prisma.caseNote.createMany({
    data: [
      { caseId: c3.id, authorId: 'TARAKESH', body: 'OTP not received for 15+ minutes during NEFT transaction. Had to abort payment.', createdAt: daysAgo(7) },
      { caseId: c3.id, authorId: 'ROHIT_V',  body: 'Investigated SMTP logs — gateway delay confirmed. Escalated to infra team.', createdAt: daysAgo(6) },
      { caseId: c3.id, authorId: 'ROHIT_V',  body: 'Issue resolved. OTP gateway latency fixed. Transaction fee waived as goodwill gesture.', createdAt: daysAgo(5) },
    ],
    skipDuplicates: true,
  });

  // ─── 7. FRAUD EVENTS (additional — login, bene add, velocity) ───────────────
  const fraudExtras = [
    { eventType: 'LOGIN',              riskScore: 0.12, riskLevel: 'LOW',    decision: 'EXECUTE',   ip: '203.192.42.10', daysA: 1, desc: 'Normal login from known device' },
    { eventType: 'LOGIN',              riskScore: 0.55, riskLevel: 'MEDIUM', decision: 'CHALLENGE', ip: '185.220.101.45', daysA: 3, desc: 'Login from new country: SG' },
    { eventType: 'BENEFICIARY_ADD',    riskScore: 0.22, riskLevel: 'LOW',    decision: 'EXECUTE',   ip: '203.192.42.10', daysA: 8, desc: 'New beneficiary added (standard)' },
    { eventType: 'BENEFICIARY_ACTIVATE', riskScore: 0.35, riskLevel: 'MEDIUM', decision: 'CHALLENGE', ip: '203.192.42.10', daysA: 0, desc: 'Beneficiary BEN006 activated during cooling period' },
    { eventType: 'VELOCITY',           riskScore: 0.78, riskLevel: 'HIGH',   decision: 'HOLD',      ip: '203.192.42.10', daysA: 0, desc: '3 payments in 2 hours — velocity limit triggered' },
    { eventType: 'PAYMENT_MODIFY',     riskScore: 0.48, riskLevel: 'MEDIUM', decision: 'CHALLENGE', ip: '203.192.42.10', daysA: 4, desc: 'Amount modified from ₹5L to ₹18L on draft payment' },
  ];

  for (const fe of fraudExtras) {
    const existing = await prisma.fraudEvent.findFirst({
      where: { eventType: fe.eventType, createdAt: { gte: daysAgo(fe.daysA + 1), lte: daysAgo(Math.max(0, fe.daysA - 1)) } },
    });
    if (!existing) {
      await prisma.fraudEvent.create({
        data: {
          eventId: `${fe.eventType.toLowerCase()}:demo:${fe.daysA}:${fe.riskLevel}`,
          userId: userMap['TARAKESH'],
          eventType: fe.eventType,
          riskScore: fe.riskScore,
          riskLevel: fe.riskLevel as RiskLevel,
          decision: fe.decision,
          ip: fe.ip,
          deviceFingerprint: fe.ip === '185.220.101.45' ? 'fp_unknown_mobile_sg' : 'fp_demo_desktop_chrome',
          modelScores: { heuristic: fe.riskScore, sentinel: fe.riskScore * 0.95 },
          shapReasons: [
            { feature: 'event_type', value: fe.eventType, contribution: 0.10 },
            { feature: 'risk_level', value: fe.riskLevel, contribution: fe.riskScore },
          ],
          createdAt: daysAgo(fe.daysA),
        },
      });
    }
  }

  // ─── 8. LOGIN EVENTS ────────────────────────────────────────────────────────
  const loginEventsData = [
    { userId: userMap['TARAKESH'], success: true,  ip: '203.192.42.10', ua: 'Chrome/125 Linux', daysA: 0,  riskScore: 0.08 },
    { userId: userMap['TARAKESH'], success: true,  ip: '203.192.42.10', ua: 'Chrome/125 Linux', daysA: 1,  riskScore: 0.06 },
    { userId: userMap['TARAKESH'], success: false, ip: '185.220.101.45', ua: 'Unknown/1.0',      daysA: 3,  riskScore: 0.72 },
    { userId: userMap['TARAKESH'], success: true,  ip: '203.192.42.10', ua: 'Chrome/125 Linux', daysA: 3,  riskScore: 0.55 },
    { userId: userMap['PRIYA_A'],  success: true,  ip: '117.96.12.88',  ua: 'Firefox/124 Win',  daysA: 0,  riskScore: 0.05 },
    { userId: userMap['PRIYA_A'],  success: true,  ip: '117.96.12.88',  ua: 'Firefox/124 Win',  daysA: 2,  riskScore: 0.04 },
    { userId: userMap['ROHIT_V'],  success: true,  ip: '49.37.221.100', ua: 'Safari/17 macOS',  daysA: 1,  riskScore: 0.03 },
    { userId: userMap['TARAKESH'], success: false, ip: '203.192.42.10', ua: 'Chrome/125 Linux', daysA: 5,  riskScore: 0.09 },
    { userId: userMap['TARAKESH'], success: false, ip: '203.192.42.10', ua: 'Chrome/125 Linux', daysA: 5,  riskScore: 0.09 },
    { userId: userMap['TARAKESH'], success: true,  ip: '203.192.42.10', ua: 'Chrome/125 Linux', daysA: 5,  riskScore: 0.10 },
  ];

  for (const le of loginEventsData) {
    await prisma.loginEvent.create({
      data: {
        userId: le.userId,
        customerId: customer.id,
        ip: le.ip,
        userAgent: le.ua,
        deviceFingerprint: le.ip === '185.220.101.45' ? 'fp_unknown_mobile_sg' : 'fp_demo_desktop_chrome',
        success: le.success,
        riskScore: le.riskScore,
        createdAt: daysAgo(le.daysA),
      },
    });
  }

  // ─── 9. AUDIT LOGS ──────────────────────────────────────────────────────────
  const auditEntries = [
    { actorId: 'TARAKESH', action: 'BENEFICIARY_ADD',      entity: 'Beneficiary', entityId: beneByCode['BEN006']?.id, after: { code: 'BEN006', name: 'Nova Traders International' }, ip: '203.192.42.10', daysA: 1 },
    { actorId: 'PRIYA_A',  action: 'BENEFICIARY_ACTIVATE', entity: 'Beneficiary', entityId: beneByCode['BEN006']?.id, before: { status: 'PENDING' }, after: { status: 'ACTIVE' }, ip: '117.96.12.88', daysA: 0 },
    { actorId: 'TARAKESH', action: 'PROFILE_UPDATE',       entity: 'User',        entityId: userMap['TARAKESH'], before: { mobile: '9820011234' }, after: { mobile: '9820011234' }, ip: '203.192.42.10', daysA: 3 },
    { actorId: 'TARAKESH', action: 'PASSWORD_CHANGE',      entity: 'User',        entityId: userMap['TARAKESH'], after: { kind: 'LOGIN', changed: true }, ip: '203.192.42.10', daysA: 7 },
    { actorId: 'PRIYA_A',  action: 'BENEFICIARY_ACTIVATE', entity: 'Beneficiary', entityId: beneByCode['BEN005']?.id, before: { status: 'PENDING' }, after: { status: 'ACTIVE' }, ip: '117.96.12.88', daysA: 10 },
    { actorId: 'TARAKESH', action: 'BENEFICIARY_ADD',      entity: 'Beneficiary', entityId: beneByCode['BEN007']?.id, after: { code: 'BEN007', name: 'Rajesh Kumar Trading Co' }, ip: '203.192.42.10', daysA: 9 },
    { actorId: 'SYSTEM',   action: 'ACCOUNT_FREEZE',       entity: 'Account',     entityId: currentAccount.id, after: { reason: 'CRITICAL fraud event', frozenBy: 'AI_ENGINE' }, ip: null, daysA: 2 },
    { actorId: 'PRIYA_A',  action: 'CASE_STATUS_UPDATE',   entity: 'Case',        entityId: null, before: { status: 'OPEN' }, after: { status: 'IN_REVIEW' }, ip: '117.96.12.88', daysA: 1 },
  ];

  for (const a of auditEntries) {
    await prisma.auditLog.create({
      data: {
        actorId: a.actorId,
        action: a.action,
        entity: a.entity,
        entityId: a.entityId ?? null,
        before: a.before ?? Prisma.JsonNull,
        after: a.after ?? Prisma.JsonNull,
        ip: a.ip,
        createdAt: daysAgo(a.daysA),
      },
    });
  }

  // ─── 10. Summary ────────────────────────────────────────────────────────────
  const counts = {
    customers:    await prisma.customer.count(),
    users:        await prisma.user.count(),
    accounts:     await prisma.account.count(),
    beneficiaries: await prisma.beneficiary.count(),
    payments:     await prisma.payment.count(),
    ledgerEntries: await prisma.ledgerEntry.count(),
    fraudEvents:  await prisma.fraudEvent.count(),
    cases:        await prisma.case.count(),
    caseNotes:    await prisma.caseNote.count(),
    loginEvents:  await prisma.loginEvent.count(),
    auditLogs:    await prisma.auditLog.count(),
  };
  console.log('\n✅ Seed complete:');
  console.table(counts);
  console.log(`\n🏦 Demo login → Customer: 83840226 | User: TARAKESH | Password: ${LOGIN_PASSWORD}`);
  console.log(`🔑 Transaction Password: ${TXN_PASSWORD}`);
  console.log(`\n📊 Demo scenarios ready:`);
  console.log(`  ✅ LOW risk payments  — 13 completed clean transactions`);
  console.log(`  🟡 MEDIUM risk        — 3 challenged+completed, 1 login from SG`);
  console.log(`  🟠 HIGH risk          — 2 HELD payments awaiting analyst`);
  console.log(`  🔴 CRITICAL           — 1 BLOCKED payment, case opened`);
  console.log(`  📋 Analyst feed       — live fraud events, held queue, cases`);
  console.log(`  📁 Disputes           — 2 open cases, 1 resolved grievance`);
  console.log(`  📈 Statement          — 30-day ledger with credits & debits`);
  console.log(`  👥 Beneficiaries      — 10 active, 2 pending, 1 rejected, 1 name-mismatch`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
