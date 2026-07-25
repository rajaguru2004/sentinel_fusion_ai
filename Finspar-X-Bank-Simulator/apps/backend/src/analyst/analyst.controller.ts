import { Controller, Get, Logger, Param, Post, Query, Sse, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { interval, merge, type Observable } from 'rxjs';
import { finalize, map } from 'rxjs/operators';
import { AnalystService } from './analyst.service';
import { LiveAlertsService } from '../fraud/live-alerts.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';

@ApiTags('analyst')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('analyst')
export class AnalystController {
  private readonly log = new Logger(AnalystController.name);

  constructor(
    private readonly analyst: AnalystService,
    private readonly live: LiveAlertsService,
  ) {}

  @Get('stats')
  stats() {
    return this.analyst.stats();
  }

  @Get('feed')
  feed(@Query('limit') limit?: string) {
    return this.analyst.feed(limit ? Number(limit) : 30);
  }

  @Get('cases')
  cases() {
    return this.analyst.cases();
  }

  /**
   * Live verdict stream (§6). HELD/BLOCKED cases appear the instant confirm()
   * produces them, instead of on the next poll.
   *
   * SkipThrottle: this is one long-lived connection per console, not a request
   * rate — the default tier would kill it on reconnect storms.
   *
   * Authentication works here precisely because the JWT moved into a cookie
   * (§4): EventSource cannot set an Authorization header, so a bearer-only API
   * would have forced the token into the query string, i.e. into every access
   * log along the path.
   */
  @SkipThrottle()
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    const count = this.live.trackSubscriber(1);
    this.log.log(`Analyst console attached (${count} live)`);

    return merge(
      this.live.stream().pipe(map((alert) => ({ data: alert }) as MessageEvent)),
      // Proxies and load balancers drop idle connections; a periodic comment
      // frame keeps the stream alive without polluting the alert feed.
      interval(25_000).pipe(map(() => ({ type: 'ping', data: { at: new Date().toISOString() } }) as MessageEvent)),
    ).pipe(
      finalize(() => {
        const left = this.live.trackSubscriber(-1);
        this.log.log(`Analyst console detached (${left} live)`);
      }),
    );
  }

  /**
   * Case correlation (§6) — other events sharing this event's user, device or
   * IP inside a time window. The seed of an entity graph, built from columns
   * FraudEvent already carries.
   */
  @Get('events/:id/related')
  related(@Param('id') id: string, @Query('windowHours') windowHours?: string) {
    return this.analyst.relatedEvents(id, windowHours ? Number(windowHours) : 24);
  }

  /** Payments currently on hold — the authorizer's review queue. */
  @Get('held')
  held(@CurrentUser() user: JwtPayload) {
    return this.analyst.heldPayments(user);
  }

  /** Release a held payment back to the maker to re-authorise. Authorizer only. */
  @Post('payments/:id/release')
  release(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.analyst.release(user, id);
  }

  /** Reject a held payment as fraudulent (cancels it). Authorizer only. */
  @Post('payments/:id/reject')
  reject(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.analyst.reject(user, id);
  }
}
