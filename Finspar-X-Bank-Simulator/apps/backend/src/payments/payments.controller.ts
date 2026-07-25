import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Rail } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { InitiatePaymentDto, SubmitPaymentDto, UpdatePaymentDto } from './dto/payment.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  private ctx(req: Request, user: JwtPayload) {
    return {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      deviceFingerprint: (req.headers['x-device-fingerprint'] as string) ?? undefined,
      mockCountry: (req.headers['x-mock-country'] as string) ?? undefined,
    };
  }

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Query('rail') rail?: Rail,
    @Query('refNo') refNo?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.payments.list(user, {
      rail,
      refNo,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get(':id')
  view(@Param('id') id: string) {
    return this.payments.view(id);
  }

  @Post()
  initiate(@CurrentUser() user: JwtPayload, @Body() dto: InitiatePaymentDto) {
    return this.payments.initiate(user, dto);
  }

  @Post(':id/confirm')
  confirm(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Req() req: Request) {
    return this.payments.confirm(user, id, this.ctx(req, user));
  }

  @Post(':id/submit')
  submit(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SubmitPaymentDto) {
    return this.payments.submit(user, id, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdatePaymentDto) {
    return this.payments.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.payments.remove(user, id);
  }
}
