import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import axios from 'axios';
import type { Response } from 'express';
import { PrismaService } from './prisma/prisma.service';
import { ScorerHealthService } from './fraud/scorer-health.service';
import { env } from './common/env';

type DepStatus = 'up' | 'down' | 'disabled';

@ApiTags('health')
@Controller()
// Orchestrators poll these on a short interval; throttling them would take the
// service out of rotation for being healthy.
@SkipThrottle()
export class AppController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scoringHealth: ScorerHealthService,
  ) {}

  /**
   * Liveness. "Is the process up and can it reach its database?" Cheap enough to
   * poll frequently. Unchanged shape — existing probes keep working.
   */
  @Get('health')
  async health(): Promise<{ status: string; db: string; time: string }> {
    return { status: 'ok', db: await this.checkDb(), time: new Date().toISOString() };
  }

  /**
   * Readiness (ENHANCEMENTS.md §3) — "is the MONEY PATH serviceable?", which is a
   * stronger question than "did the process boot".
   *
   * Returns 503 when the database is unreachable, because without it no payment
   * can be posted at all.
   *
   * It deliberately does NOT 503 on a Sentinel outage: fail-open is the designed
   * behaviour, payments still flow on the heuristic, and taking the instance out
   * of the load balancer would convert a degraded-but-working system into an
   * outage. Sentinel's state is reported as `degraded` instead — visible to an
   * operator and to the analyst console banner, without being fatal.
   */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [db, sentinel] = await Promise.all([this.checkDb(), this.checkSentinel()]);
    const scoring = this.scoringHealth.snapshot();

    const ready = db === 'up';
    const degraded = sentinel === 'down' || scoring.degraded;
    if (!ready) res.status(503);

    return {
      status: ready ? (degraded ? 'degraded' : 'ok') : 'unavailable',
      ready,
      time: new Date().toISOString(),
      dependencies: { db, sentinel },
      scoring,
    };
  }

  /**
   * Just the scoring posture — polled by the analyst console to raise its
   * "fraud scoring degraded" banner. Split from /health/ready so the UI is not
   * coupled to a route whose status code is meaningful to orchestration.
   */
  @Get('health/scoring')
  @HttpCode(200)
  scoring() {
    return { sentinelEnabled: env.sentinel.enabled, ...this.scoringHealth.snapshot() };
  }

  private async checkDb(): Promise<DepStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkSentinel(): Promise<DepStatus> {
    if (!env.sentinel.enabled) return 'disabled';
    try {
      await axios.get(`${env.sentinel.url}/health`, {
        timeout: env.sentinel.timeoutMs,
        headers: { 'X-API-Key': env.sentinel.apiKey },
      });
      return 'up';
    } catch {
      return 'down';
    }
  }
}
