import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AppSetting } from '@prisma/client';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/settings.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';

/**
 * Runtime policy the operator can change without a restart (§8.14).
 *
 * ACCESS: any authenticated user, which suits the single-operator demo flow
 * where the MAKER account drives the whole walkthrough. To restrict editing to
 * fraud-ops, add `@Roles('AUTHORIZER')` + `RolesGuard` to `update()` below —
 * the guard and decorator already exist and the analyst release/reject routes
 * use exactly that pattern.
 */
@ApiTags('settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async get() {
    return view(await this.settings.get());
  }

  @Put()
  async update(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateSettingsDto,
    @Req() req: Request,
  ) {
    return view(await this.settings.update(dto, { userId: user.userId, ip: req.ip }));
  }
}

/**
 * GET returns exactly the shape PUT accepts, so the page can round-trip its own
 * form state. The limit crosses the wire in rupees (the unit the form edits) —
 * paise stay server-side where the arithmetic happens.
 */
function view(s: AppSetting) {
  return {
    alertEnabled: s.alertEnabled,
    alertMinLevel: s.alertMinLevel,
    blockEnabled: s.blockEnabled,
    blockMinLevel: s.blockMinLevel,
    perTxnLimit: Number(s.perTxnLimitPaise) / 100,
    cutoffEnabled: s.cutoffEnabled,
    cutoffHour: s.cutoffHour,
    cutoffMinute: s.cutoffMinute,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
  };
}
