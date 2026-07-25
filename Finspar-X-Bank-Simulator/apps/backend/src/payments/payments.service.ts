import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { OtpPurpose, PaymentStatus, Rail, RiskLevel, TransferMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from '../otp/otp.service';
import { FraudGateway } from '../fraud/fraud-gateway.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuthService } from '../auth/auth.service';
import { amountInWords } from './amount-in-words';
import type { InitiatePaymentDto, SubmitPaymentDto, UpdatePaymentDto } from './dto/payment.dto';
import type { JwtPayload } from '../auth/jwt.strategy';

const PER_TXN_LIMIT_PAISE = 2_500_000_00n; // ₹25,00,000
const EDITABLE: PaymentStatus[] = [PaymentStatus.NEW, PaymentStatus.PENDING_AUTH, PaymentStatus.HELD];
// Statuses that can still be submitted (final OTP + txn password). CHALLENGED is
// the state a MEDIUM-risk payment is parked in after confirm() — it must remain
// completable, so it is submittable even though it is not further editable.
const SUBMITTABLE: PaymentStatus[] = [
  PaymentStatus.NEW,
  PaymentStatus.PENDING_AUTH,
  PaymentStatus.CHALLENGED,
];

const RAIL_ALLOW: Record<Rail, (b: { allowIFT: boolean; allowRTGS: boolean; allowNEFT: boolean; allowIMPS: boolean }) => boolean> = {
  IFT: (b) => b.allowIFT,
  RTGS: (b) => b.allowRTGS,
  NEFT: (b) => b.allowNEFT,
  IMPS: (b) => b.allowIMPS,
};

interface Ctx {
  ip?: string;
  userAgent?: string;
  deviceFingerprint?: string;
  mockCountry?: string; // dev mock-VPN override (X-Mock-Country header)
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly gateway: FraudGateway,
    private readonly ledger: LedgerService,
    private readonly auth: AuthService,
  ) {}

  private toPaise(rupees: number): bigint {
    return BigInt(Math.round(rupees * 100));
  }

  private async genRefNo(customerId: string): Promise<string> {
    const now = new Date();
    const ddmmyyyy = `${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}${now.getFullYear()}`;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayCount = await this.prisma.payment.count({
      where: { customerId, createdAt: { gte: start } },
    });
    return `GX${ddmmyyyy}${String(todayCount + 1).padStart(6, '0')}`;
  }

  /** Step 1 — Initiate. Creates a NEW draft payment. Only ACTIVE beneficiaries. */
  async initiate(user: JwtPayload, dto: InitiatePaymentDto) {
    const account = await this.prisma.account.findFirst({
      where: { id: dto.debitAccountId, customerId: user.customerId },
    });
    if (!account) throw new BadRequestException('Invalid debit account');

    const beneficiary = await this.prisma.beneficiary.findFirst({
      where: { id: dto.beneficiaryId, customerId: user.customerId },
    });
    if (!beneficiary) throw new BadRequestException('Beneficiary not found');
    if (beneficiary.status !== 'ACTIVE') throw new BadRequestException('Beneficiary is not active');
    if (!RAIL_ALLOW[dto.rail](beneficiary)) {
      throw new BadRequestException(`Beneficiary is not enabled for ${dto.rail}`);
    }

    const amount = this.toPaise(dto.amount);
    if (amount <= 0n) throw new BadRequestException('Amount must be positive');

    const dupRef = await this.prisma.payment.findFirst({
      where: { customerId: user.customerId, custRefNo: dto.custRefNo, NOT: { status: PaymentStatus.DELETED } },
    });
    if (dupRef) throw new BadRequestException('Customer Reference No already used');

    const payment = await this.prisma.payment.create({
      data: {
        refNo: await this.genRefNo(user.customerId),
        custRefNo: dto.custRefNo,
        customerId: user.customerId,
        debitAccountId: account.id,
        beneficiaryId: beneficiary.id,
        amount,
        amountInWords: amountInWords(dto.amount),
        rail: dto.rail,
        paymentMode: this.modeLabel(dto.rail),
        transferMode: (dto.transferMode as TransferMode) ?? TransferMode.IFSC_ACCOUNT,
        remarks: dto.remarks,
        status: PaymentStatus.NEW,
        initiatedBy: user.userId,
      },
    });
    return this.view(payment.id);
  }

  private modeLabel(rail: Rail): string {
    return {
      IFT: 'Fund Transfer - Own Bank Account',
      RTGS: 'Fund Transfer - Other Bank (RTGS)',
      NEFT: 'Fund Transfer - Other Bank (NEFT)',
      IMPS: 'IMPS',
    }[rail];
  }

  /**
   * Step 2->3 Confirm — routes through the fraud gateway BEFORE the ledger (§9).
   * LOW: issue OTP. MEDIUM: issue OTP + risk notice (CHALLENGED). HIGH: hold.
   * CRITICAL: block + freeze account.
   */
  async confirm(user: JwtPayload, paymentId: string, ctx: Ctx) {
    const payment = await this.ownedEditable(user.customerId, paymentId);

    // An authorizer already reviewed and released this hold. Skip the fraud
    // gateway so re-authorising does not re-trigger the same HOLD — go straight
    // to OTP. The original risk verdict is preserved for the audit trail.
    if (payment.reviewApproved) {
      const dbUser = await this.prisma.user.findUnique({ where: { id: user.sub } });
      const { requestId } = await this.otp.issue({
        purpose: OtpPurpose.PAYMENT,
        email: dbUser!.email,
        userId: user.sub,
        paymentId: payment.id,
      });
      return {
        outcome: 'OTP' as const,
        otpRequestId: requestId,
        riskScore: payment.riskScore ?? 0,
        riskLevel: payment.riskLevel ?? RiskLevel.LOW,
        reasons: Array.isArray(payment.riskReasons) ? (payment.riskReasons as string[]) : [],
      };
    }

    const beneficiary = await this.prisma.beneficiary.findUnique({ where: { id: payment.beneficiaryId } });
    const nameMismatch =
      !!beneficiary?.nameAsFetched && beneficiary.name.toLowerCase() !== beneficiary.nameAsFetched.toLowerCase();

    const event = await this.gateway.buildPaymentEvent({
      userId: user.sub,
      customerId: user.customerId,
      paymentId: payment.id,
      debitAccountId: payment.debitAccountId,
      amountPaise: payment.amount,
      rail: payment.rail,
      beneficiaryId: payment.beneficiaryId,
      nameMismatch,
      ctx: { ip: ctx.ip, userAgent: ctx.userAgent, deviceFingerprint: ctx.deviceFingerprint, sessionId: user.sub, mockCountry: ctx.mockCountry },
    });
    const assessment = await this.gateway.assess(event, {
      userId: user.sub,
      paymentId: payment.id,
      ip: ctx.ip,
      deviceFingerprint: ctx.deviceFingerprint,
    });

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        riskScore: assessment.riskScore,
        riskLevel: assessment.riskLevel,
        riskReasons: assessment.reasons,
      },
    });

    const risk = { riskScore: assessment.riskScore, riskLevel: assessment.riskLevel, reasons: assessment.reasons };

    if (assessment.decision === 'BLOCK') {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.BLOCKED } });
      await this.freezeAccount(user.customerId, payment.id, assessment.reasons);
      return { outcome: 'BLOCKED' as const, ...risk };
    }
    if (assessment.decision === 'HOLD') {
      await this.ledger.holdPayment(payment.id);
      return { outcome: 'HELD' as const, ...risk };
    }

    // LOW / MEDIUM — challenge with OTP.
    const dbUser = await this.prisma.user.findUnique({ where: { id: user.sub } });
    const { requestId } = await this.otp.issue({
      purpose: OtpPurpose.PAYMENT,
      email: dbUser!.email,
      userId: user.sub,
      paymentId: payment.id,
    });
    if (assessment.decision === 'CHALLENGE') {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.CHALLENGED } });
    }
    return {
      outcome: assessment.decision === 'CHALLENGE' ? ('CHALLENGE' as const) : ('OTP' as const),
      otpRequestId: requestId,
      ...risk,
    };
  }

  /** Final submit — verify txn password + OTP, then post (or hold by cutoff/limit). */
  async submit(user: JwtPayload, paymentId: string, dto: SubmitPaymentDto) {
    const payment = await this.ownedSubmittable(user.customerId, paymentId);

    const okPwd = await this.auth.verifyTxnPassword(user.sub, dto.txnPassword);
    if (!okPwd) throw new BadRequestException('Incorrect transaction password');

    const verified = await this.otp.verify(dto.otpRequestId, dto.code);
    if (verified.paymentId !== payment.id) throw new BadRequestException('OTP does not match this payment');

    // Over-limit or past NEFT/RTGS cut-off -> hold for next working day.
    const overLimit = payment.amount > PER_TXN_LIMIT_PAISE;
    const pastCutoff = this.isPastCutoff() && (payment.rail === 'NEFT' || payment.rail === 'RTGS');
    if (overLimit || pastCutoff) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { valueDate: this.nextWorkingDay(), status: PaymentStatus.PROCESSING },
      });
      await this.ledger.holdPayment(payment.id);
      return { outcome: 'HELD_CUTOFF' as const, refNo: payment.refNo, reason: overLimit ? 'Over per-transaction limit' : 'After cut-off time' };
    }

    await this.prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.PROCESSING } });
    await this.ledger.postPayment(payment.id);
    const posted = await this.prisma.payment.findUnique({ where: { id: payment.id } });
    return { outcome: 'COMPLETED' as const, refNo: posted!.refNo, status: posted!.status, riskLevel: posted!.riskLevel };
  }

  private isPastCutoff(): boolean {
    const now = new Date();
    return now.getHours() > 19 || (now.getHours() === 19 && now.getMinutes() >= 30);
  }

  private nextWorkingDay(): Date {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d;
  }

  private async freezeAccount(customerId: string, paymentId: string, reasons: string[]): Promise<void> {
    await this.prisma.customer.update({ where: { id: customerId }, data: { status: 'SUSPENDED' } });
    await this.prisma.case.create({
      data: {
        trackingRef: `AI${Date.now().toString().slice(-8)}`,
        customerId,
        paymentId,
        source: 'AI_FLAGGED',
        fraudType: 'CRITICAL_RISK_BLOCK',
        status: 'OPEN',
        resolution: reasons.join('; '),
      },
    });
  }

  // --- Modify Payments (§8.11) --------------------------------------------
  async list(user: JwtPayload, filter: { rail?: Rail; refNo?: string; from?: Date; to?: Date }) {
    const payments = await this.prisma.payment.findMany({
      where: {
        customerId: user.customerId,
        rail: filter.rail,
        refNo: filter.refNo ? { contains: filter.refNo, mode: 'insensitive' } : undefined,
        createdAt: { gte: filter.from, lte: filter.to },
        NOT: { status: PaymentStatus.DELETED },
      },
      orderBy: { createdAt: 'desc' },
      include: { beneficiary: { select: { name: true, code: true } } },
      take: 200,
    });
    return payments.map((p) => ({
      id: p.id,
      refNo: p.refNo,
      custRefNo: p.custRefNo,
      amount: p.amount,
      rail: p.rail,
      paymentMode: p.paymentMode,
      status: p.status,
      riskLevel: p.riskLevel,
      beneficiaryName: p.beneficiary.name,
      transactionDate: p.createdAt,
      remarks: p.remarks,
      editable: EDITABLE.includes(p.status),
    }));
  }

  async view(paymentId: string) {
    const p = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { beneficiary: true, debitAccount: { select: { accountNumber: true, accountName: true, clearBalance: true, holdAmount: true } } },
    });
    if (!p) throw new NotFoundException('Payment not found');
    return p;
  }

  async update(user: JwtPayload, paymentId: string, dto: UpdatePaymentDto) {
    const payment = await this.ownedEditable(user.customerId, paymentId);

    const data: {
      amount?: bigint;
      amountInWords?: string;
      custRefNo?: string;
      remarks?: string;
    } = {};

    if (dto.amount !== undefined) {
      const amount = this.toPaise(dto.amount);
      if (amount <= 0n) throw new BadRequestException('Amount must be positive');
      data.amount = amount;
      data.amountInWords = amountInWords(dto.amount);
    }

    if (dto.custRefNo !== undefined && dto.custRefNo !== payment.custRefNo) {
      const dupRef = await this.prisma.payment.findFirst({
        where: {
          customerId: user.customerId,
          custRefNo: dto.custRefNo,
          NOT: { OR: [{ id: payment.id }, { status: PaymentStatus.DELETED }] },
        },
      });
      if (dupRef) throw new BadRequestException('Customer Reference No already used');
      data.custRefNo = dto.custRefNo;
    }

    if (dto.remarks !== undefined) data.remarks = dto.remarks;

    const updated = await this.prisma.payment.update({ where: { id: payment.id }, data });

    // Re-score on the edit path when the amount changed — a modified amount is a
    // materially different risk. Persist the fresh verdict so the next confirm/
    // authorize step and the risk badge reflect it.
    if (data.amount !== undefined) {
      const beneficiary = await this.prisma.beneficiary.findUnique({ where: { id: updated.beneficiaryId } });
      const nameMismatch =
        !!beneficiary?.nameAsFetched && beneficiary.name.toLowerCase() !== beneficiary.nameAsFetched.toLowerCase();
      const event = await this.gateway.buildPaymentEvent({
        userId: user.sub,
        customerId: user.customerId,
        paymentId: updated.id,
        debitAccountId: updated.debitAccountId,
        amountPaise: updated.amount,
        rail: updated.rail,
        beneficiaryId: updated.beneficiaryId,
        nameMismatch,
        ctx: { sessionId: user.sub },
        eventType: 'PAYMENT_MODIFY',
      });
      const assessment = await this.gateway.assess(event, { userId: user.sub, paymentId: updated.id });
      await this.prisma.payment.update({
        where: { id: updated.id },
        // Amount changed -> any prior authorizer approval is stale; re-score applies.
        data: { riskScore: assessment.riskScore, riskLevel: assessment.riskLevel, riskReasons: assessment.reasons, reviewApproved: false },
      });
    }

    return { id: updated.id, refNo: updated.refNo, amount: updated.amount.toString() };
  }

  async remove(user: JwtPayload, paymentId: string) {
    const payment = await this.ownedEditable(user.customerId, paymentId);
    await this.prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.DELETED, deletedAt: new Date() } });
    return { deleted: true };
  }

  private async ownedEditable(customerId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({ where: { id: paymentId, customerId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (!EDITABLE.includes(payment.status)) {
      throw new ForbiddenException(`Payment in status ${payment.status} can no longer be modified`);
    }
    return payment;
  }

  private async ownedSubmittable(customerId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({ where: { id: paymentId, customerId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (!SUBMITTABLE.includes(payment.status)) {
      throw new ForbiddenException(`Payment in status ${payment.status} can no longer be submitted`);
    }
    return payment;
  }
}
