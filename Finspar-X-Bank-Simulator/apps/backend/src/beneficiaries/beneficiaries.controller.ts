import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BeneficiaryStatus } from '@prisma/client';
import { BeneficiariesService } from './beneficiaries.service';
import {
  CreateBeneficiaryDto,
  UpdateBeneficiaryDto,
  FetchNameDto,
  BulkIdsDto,
} from './dto/beneficiary.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';

@ApiTags('beneficiaries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('beneficiaries')
export class BeneficiariesController {
  constructor(private readonly beneficiaries: BeneficiariesService) {}

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: BeneficiaryStatus,
    @Query('code') code?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.beneficiaries.list(user.customerId, {
      status,
      code,
      activeOnly: activeOnly === 'true',
    });
  }

  @Post('fetch-name')
  fetchName(@Body() dto: FetchNameDto) {
    return this.beneficiaries.fetchName(dto.accountNumber);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateBeneficiaryDto) {
    return this.beneficiaries.create(user.customerId, user.userId, dto);
  }

  @Put(':id')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateBeneficiaryDto) {
    return this.beneficiaries.update(user.customerId, id, dto);
  }

  @Post('activate')
  activate(@CurrentUser() user: JwtPayload, @Body() dto: BulkIdsDto) {
    return this.beneficiaries.activate(user.customerId, dto.ids, user.userId);
  }

  @Post('reject')
  reject(@CurrentUser() user: JwtPayload, @Body() dto: BulkIdsDto) {
    return this.beneficiaries.reject(user.customerId, dto.ids);
  }

  @Post('delete')
  remove(@CurrentUser() user: JwtPayload, @Body() dto: BulkIdsDto) {
    return this.beneficiaries.remove(user.customerId, dto.ids);
  }
}
