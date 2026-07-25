import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { BeneficiaryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SentinelIngest } from '../fraud/sentinel-ingest';
import type { CreateBeneficiaryDto, UpdateBeneficiaryDto } from './dto/beneficiary.dto';

// A pool of fabricated account-holder names for simulated bank name-resolution.
const FETCH_NAMES = [
  'Kumar Yarns Pvt Ltd',
  'Deccan Dyes',
  'Ganesh Logistics',
  'Nova Traders',
  'Meghna Exports',
  'Anand Steels',
  'Zenith Chemicals',
  'Sunrise Fabrics',
  'Coastal Freight Co',
  'Prime Packaging LLP',
];

@Injectable()
export class BeneficiariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: SentinelIngest,
  ) {}

  async list(
    customerId: string,
    filter?: { status?: BeneficiaryStatus; code?: string; activeOnly?: boolean },
  ) {
    return this.prisma.beneficiary.findMany({
      where: {
        customerId,
        status: filter?.activeOnly ? BeneficiaryStatus.ACTIVE : filter?.status,
        code: filter?.code ? { contains: filter.code, mode: 'insensitive' } : undefined,
        NOT: filter?.activeOnly ? undefined : { status: BeneficiaryStatus.DELETED },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(customerId: string, id: string) {
    const b = await this.prisma.beneficiary.findFirst({ where: { id, customerId } });
    if (!b) throw new NotFoundException('Beneficiary not found');
    return b;
  }

  /**
   * Simulated "Fetch Beneficiary" — resolves the account-holder name from the
   * destination bank. Deterministic per account number so the demo is stable.
   * A mismatch vs the entered name is a fraud signal (§8.7).
   */
  fetchName(accountNumber: string): { nameAsFetched: string } {
    const hash = createHash('sha256').update(accountNumber).digest();
    const name = FETCH_NAMES[hash[0] % FETCH_NAMES.length];
    return { nameAsFetched: name };
  }

  private assertHasRail(dto: { allowIFT?: boolean; allowRTGS?: boolean; allowNEFT?: boolean; allowIMPS?: boolean }): void {
    if (!dto.allowIFT && !dto.allowRTGS && !dto.allowNEFT && !dto.allowIMPS) {
      throw new BadRequestException('Select at least one Beneficiary Type (IFT/RTGS/NEFT/IMPS)');
    }
  }

  /** Add — new beneficiaries are created PENDING, unusable until activated (§8.7). */
  async create(customerId: string, actorId: string, dto: CreateBeneficiaryDto) {
    this.assertHasRail(dto);
    const nonIft = dto.allowRTGS || dto.allowNEFT || dto.allowIMPS;
    if (nonIft && !dto.ifsc) {
      throw new BadRequestException('IFSC is required for non-IFT beneficiary types');
    }
    const dup = await this.prisma.beneficiary.findUnique({
      where: { customerId_code: { customerId, code: dto.code } },
    });
    if (dup) throw new BadRequestException('Beneficiary Code already exists for this customer');

    const nameAsFetched = dto.nameAsFetched ?? this.fetchName(dto.accountNumber).nameAsFetched;

    const beneficiary = await this.prisma.beneficiary.create({
      data: {
        customerId,
        code: dto.code,
        name: dto.name,
        nameAsFetched,
        accountNumber: dto.accountNumber,
        ifsc: dto.ifsc,
        isOwnBank: dto.isOwnBank ?? false,
        allowIFT: dto.allowIFT ?? false,
        allowRTGS: dto.allowRTGS ?? false,
        allowNEFT: dto.allowNEFT ?? false,
        allowIMPS: dto.allowIMPS ?? false,
        addressLine1: dto.addressLine1,
        addressLine2: dto.addressLine2,
        state: dto.state,
        city: dto.city,
        pinCode: dto.pinCode,
        phone: dto.phone,
        email: dto.email,
        status: BeneficiaryStatus.PENDING,
        createdBy: actorId,
      },
    });

    // Non-blocking context stream — starts the counterparty ageing clock and
    // warms the feature store so the first payment isn't scored on cold history.
    this.ingest.stream({
      eventId: `ben-add:${beneficiary.id}`,
      eventType: 'BENEFICIARY_ADD',
      userId: actorId,
      timestamp: new Date().toISOString(),
      isNewBeneficiary: true,
    });

    return beneficiary;
  }

  async update(customerId: string, id: string, dto: UpdateBeneficiaryDto) {
    await this.get(customerId, id);
    this.assertHasRail(dto);
    return this.prisma.beneficiary.update({
      where: { id },
      data: {
        name: dto.name,
        accountNumber: dto.accountNumber,
        ifsc: dto.ifsc,
        isOwnBank: dto.isOwnBank ?? false,
        allowIFT: dto.allowIFT ?? false,
        allowRTGS: dto.allowRTGS ?? false,
        allowNEFT: dto.allowNEFT ?? false,
        allowIMPS: dto.allowIMPS ?? false,
        addressLine1: dto.addressLine1,
        addressLine2: dto.addressLine2,
        state: dto.state,
        city: dto.city,
        pinCode: dto.pinCode,
        phone: dto.phone,
        email: dto.email,
        // Editing resets to PENDING — must be re-activated.
        status: BeneficiaryStatus.PENDING,
      },
    });
  }

  /**
   * Activate (§8.8). PENDING -> ACTIVE, stamps activatedAt. The 30-minute /
   * ₹50,000 cooling period is enforced later by the fraud gateway using activatedAt.
   */
  async activate(customerId: string, ids: string[], actorId: string) {
    const result = await this.prisma.beneficiary.updateMany({
      where: { id: { in: ids }, customerId, status: BeneficiaryStatus.PENDING },
      data: { status: BeneficiaryStatus.ACTIVE, activatedBy: actorId, activatedAt: new Date() },
    });
    // Non-blocking context stream for each newly activated payee.
    for (const id of ids) {
      this.ingest.stream({
        eventId: `ben-act:${id}`,
        eventType: 'BENEFICIARY_ACTIVATE',
        userId: actorId,
        timestamp: new Date().toISOString(),
      });
    }
    return { activated: result.count };
  }

  async reject(customerId: string, ids: string[]) {
    const result = await this.prisma.beneficiary.updateMany({
      where: { id: { in: ids }, customerId, status: BeneficiaryStatus.PENDING },
      data: { status: BeneficiaryStatus.REJECTED },
    });
    return { rejected: result.count };
  }

  /** Soft delete (§8.9). Historical transactions keep their reference. */
  async remove(customerId: string, ids: string[]) {
    const result = await this.prisma.beneficiary.updateMany({
      where: { id: { in: ids }, customerId, status: { not: BeneficiaryStatus.DELETED } },
      data: { status: BeneficiaryStatus.DELETED, deletedAt: new Date() },
    });
    return { deleted: result.count };
  }
}
