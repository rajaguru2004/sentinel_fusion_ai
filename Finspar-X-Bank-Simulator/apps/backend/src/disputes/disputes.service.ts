import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { SentinelFeedback } from '../fraud/sentinel-feedback';
import type { ReportFraudDto, GrievanceDto } from './dto/dispute.dto';

@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly feedback: SentinelFeedback,
  ) {}

  private trackingRef(prefix: string): string {
    return `${prefix}${Date.now().toString().slice(-9)}`;
  }

  /**
   * Report Fraudulent Transaction (§8.15). Submitting triggers an immediate debit
   * freeze + net-banking deactivation until the investigation completes.
   */
  async report(customerId: string, userEmail: string, dto: ReportFraudDto) {
    // Freeze the account (debit freeze / net-banking deactivation).
    await this.prisma.customer.update({ where: { id: customerId }, data: { status: 'SUSPENDED' } });

    const linked = await this.prisma.payment.findFirst({
      where: { customerId, refNo: dto.transactionRef },
      select: { id: true },
    });

    const kase = await this.prisma.case.create({
      data: {
        trackingRef: this.trackingRef('FR'),
        customerId,
        paymentId: linked?.id,
        source: 'CUSTOMER_REPORTED',
        fraudType: dto.fraudType,
        amount: BigInt(Math.round(dto.amount * 100)),
        status: 'OPEN',
        resolution: dto.additionalDetail,
      },
    });
    await this.prisma.case.update({
      where: { id: kase.id },
      data: {}, // placeholder for future workflow hooks
    });
    await this.prisma.caseNote.create({
      data: { caseId: kase.id, authorId: 'SYSTEM', body: `Reported: ${dto.fraudType} on ${dto.transactionRef}. Account frozen.` },
    });
    // Close the model's feedback loop — a customer-confirmed fraud is a label=1
    // outcome on the scored payment. Idempotent per event_id; best-effort.
    if (linked?.id) {
      await this.feedback.feedbackForPayment(linked.id, 1);
    }
    await this.mailer.send(
      userEmail,
      'Bank of Maharashtra — Fraud report received',
      `<p>Your report (Tracking Ref <strong>${kase.trackingRef}</strong>) is under investigation. Your account has been frozen for protection.</p>`,
    );
    return { trackingRef: kase.trackingRef, status: kase.status, frozen: true };
  }

  /** Track Request (§8.16). */
  async track(customerId: string, trackingRef: string) {
    const kase = await this.prisma.case.findFirst({
      where: { customerId, trackingRef },
      include: { notes: { orderBy: { createdAt: 'desc' } } },
    });
    if (!kase) throw new NotFoundException('No request found for that tracking reference');
    return {
      trackingRef: kase.trackingRef,
      requestDate: kase.createdAt,
      transactionRef: kase.paymentId,
      fraudType: kase.fraudType,
      amount: kase.amount,
      status: kase.status,
      lastUpdated: kase.updatedAt,
      updates: kase.notes.map((n) => ({ date: n.createdAt, body: n.body })),
    };
  }

  /** Grievance Redressal (§8.17). */
  async grievance(customerId: string, dto: GrievanceDto) {
    const kase = await this.prisma.case.create({
      data: {
        trackingRef: this.trackingRef('GR'),
        customerId,
        source: 'CUSTOMER_REPORTED',
        fraudType: `GRIEVANCE:${dto.category}`,
        status: 'OPEN',
        resolution: dto.detail,
      },
    });
    return { trackingRef: kase.trackingRef, status: kase.status };
  }
}
