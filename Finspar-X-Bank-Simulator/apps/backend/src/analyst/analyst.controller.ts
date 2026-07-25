import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AnalystService } from './analyst.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';

@ApiTags('analyst')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('analyst')
export class AnalystController {
  constructor(private readonly analyst: AnalystService) {}

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
