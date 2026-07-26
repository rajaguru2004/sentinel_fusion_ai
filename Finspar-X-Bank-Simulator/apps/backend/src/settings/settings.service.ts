import { Injectable, Logger } from '@nestjs/common';
import { AppSetting, Prisma, RiskLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { env } from '../common/env';
import type { UpdateSettingsDto } from './dto/settings.dto';

/** The one row. A fixed id is what makes the table a singleton. */
const SINGLETON = 'singleton';

/**
 * Canonical risk-band ordering. Every "at or above level X" comparison in the
 * codebase resolves through this, so alerting and blocking cannot drift apart.
 */
export const RISK_RANK: Record<RiskLevel, number> = {
  [RiskLevel.LOW]: 0,
  [RiskLevel.MEDIUM]: 1,
  [RiskLevel.HIGH]: 2,
  [RiskLevel.CRITICAL]: 3,
};

export function atOrAbove(level: RiskLevel, floor: RiskLevel): boolean {
  return RISK_RANK[level] >= RISK_RANK[floor];
}

/**
 * Cache lifetime for the settings snapshot.
 *
 * A write invalidates immediately, so on a single backend this is only a
 * backstop; it exists so a second instance (or a hand-edited row) converges
 * within a few seconds instead of never. Short enough that "save then test" on
 * the Settings page behaves the way an operator expects.
 */
const CACHE_TTL_MS = 5_000;

type ChangeListener = (settings: AppSetting) => void;

/**
 * Runtime policy, read from the database rather than the environment.
 *
 * Read on EVERY scored event and EVERY payment — a change takes effect on the
 * next transaction with no restart. The read is served from a short-lived
 * in-memory snapshot so the money path never waits on a database round-trip it
 * did not already need.
 *
 * Seeding: the row is created on first read from the current env values, so an
 * existing install inherits whatever `.env` already said instead of silently
 * reverting to defaults the operator never chose.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache: AppSetting | null = null;
  private cachedAt = 0;
  private inflight: Promise<AppSetting> | null = null;
  private readonly listeners = new Set<ChangeListener>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register a callback fired after every successful save. Used by the ledger
   * cut-off job, which has to re-arm its cron when the cut-off time moves.
   */
  onChange(listener: ChangeListener): void {
    this.listeners.add(listener);
  }

  /** Current settings. Cheap: served from cache except once every few seconds. */
  async get(): Promise<AppSetting> {
    if (this.cache && Date.now() - this.cachedAt < CACHE_TTL_MS) return this.cache;
    // Collapse a burst of concurrent misses into one query — the money path can
    // hit this from several requests at once.
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<AppSetting> {
    const row = await this.prisma.appSetting.upsert({
      where: { id: SINGLETON },
      update: {},
      create: { id: SINGLETON, ...this.envDefaults() },
    });
    this.cache = row;
    this.cachedAt = Date.now();
    return row;
  }

  /**
   * First-boot values, taken from the environment so this table starts life
   * agreeing with the `.env` the operator already tuned. Only ever used by the
   * initial create — later env edits do NOT override the stored row, because
   * the database is the source of truth once the row exists.
   */
  private envDefaults(): Partial<AppSetting> {
    const envLevel = env.riskAlert.minLevel as RiskLevel;
    return {
      alertEnabled: env.riskAlert.enabled,
      alertMinLevel: envLevel in RISK_RANK ? envLevel : RiskLevel.MEDIUM,
    };
  }

  async update(dto: UpdateSettingsDto, actor?: { userId?: string; ip?: string }): Promise<AppSetting> {
    const before = await this.get();

    const data: Partial<AppSetting> = {};
    if (dto.alertEnabled !== undefined) data.alertEnabled = dto.alertEnabled;
    if (dto.alertMinLevel !== undefined) data.alertMinLevel = dto.alertMinLevel;
    if (dto.blockEnabled !== undefined) data.blockEnabled = dto.blockEnabled;
    if (dto.blockMinLevel !== undefined) data.blockMinLevel = dto.blockMinLevel;
    if (dto.perTxnLimit !== undefined) data.perTxnLimitPaise = BigInt(Math.round(dto.perTxnLimit * 100));
    if (dto.cutoffEnabled !== undefined) data.cutoffEnabled = dto.cutoffEnabled;
    if (dto.cutoffHour !== undefined) data.cutoffHour = dto.cutoffHour;
    if (dto.cutoffMinute !== undefined) data.cutoffMinute = dto.cutoffMinute;

    const after = await this.prisma.appSetting.update({
      where: { id: SINGLETON },
      data: { ...data, updatedBy: actor?.userId },
    });

    // Changing what the fraud engine does to a payment is an operator action on
    // a par with releasing a hold — it belongs in the same audit trail.
    await this.prisma.auditLog.create({
      data: {
        actorId: actor?.userId,
        action: 'SETTINGS_UPDATE',
        entity: 'AppSetting',
        entityId: SINGLETON,
        before: toJson(before),
        after: toJson(after),
        ip: actor?.ip,
      },
    });

    this.cache = after;
    this.cachedAt = Date.now();
    this.logger.log(
      `Settings updated by ${actor?.userId ?? 'unknown'}: ` +
        `alerts ${after.alertEnabled ? `>= ${after.alertMinLevel}` : 'OFF'}, ` +
        `block ${after.blockEnabled ? `>= ${after.blockMinLevel}` : 'OFF'}, ` +
        `limit ${after.perTxnLimitPaise / 100n}, ` +
        `cutoff ${after.cutoffEnabled ? pad(after.cutoffHour) + ':' + pad(after.cutoffMinute) : 'OFF'}`,
    );

    // A listener that throws must not fail the save — the write already
    // committed, and the operator's change is real either way.
    for (const listener of this.listeners) {
      try {
        listener(after);
      } catch (e) {
        this.logger.error(`Settings change listener failed: ${String(e)}`);
      }
    }
    return after;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** BigInt is not JSON-serialisable — stringify it for the audit columns. */
function toJson(s: AppSetting): Prisma.InputJsonValue {
  return {
    alertEnabled: s.alertEnabled,
    alertMinLevel: s.alertMinLevel,
    blockEnabled: s.blockEnabled,
    blockMinLevel: s.blockMinLevel,
    perTxnLimitPaise: s.perTxnLimitPaise.toString(),
    cutoffEnabled: s.cutoffEnabled,
    cutoffHour: s.cutoffHour,
    cutoffMinute: s.cutoffMinute,
  };
}
