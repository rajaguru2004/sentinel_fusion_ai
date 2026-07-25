import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DisputesService } from './disputes.service';
import { ReportFraudDto, GrievanceDto } from './dto/dispute.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from '../auth/jwt.strategy';

@ApiTags('disputes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('disputes')
export class DisputesController {
  constructor(
    private readonly disputes: DisputesService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('report')
  async report(@CurrentUser() user: JwtPayload, @Body() dto: ReportFraudDto) {
    const dbUser = await this.prisma.user.findUnique({ where: { id: user.sub } });
    return this.disputes.report(user.customerId, dbUser?.email ?? '', dto);
  }

  @Get('track')
  track(@CurrentUser() user: JwtPayload, @Query('trackingRef') trackingRef: string) {
    return this.disputes.track(user.customerId, trackingRef);
  }

  @Post('grievance')
  grievance(@CurrentUser() user: JwtPayload, @Body() dto: GrievanceDto) {
    return this.disputes.grievance(user.customerId, dto);
  }
}
