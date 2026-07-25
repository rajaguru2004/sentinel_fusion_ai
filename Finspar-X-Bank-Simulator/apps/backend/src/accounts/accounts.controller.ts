import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AccountsService } from './accounts.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';

@ApiTags('accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('balance')
  balance(@CurrentUser() user: JwtPayload, @Query('accountType') accountType?: 'DEPOSIT' | 'FD') {
    return this.accounts.balances(user.customerId, accountType, user.sub);
  }

  @Get('statement')
  statement(
    @CurrentUser() user: JwtPayload,
    @Query('accountNumber') accountNumber: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('order') order?: 'asc' | 'desc',
  ) {
    return this.accounts.statement(
      user.customerId,
      accountNumber,
      {
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        order,
      },
      user.sub,
    );
  }

  @Get('mini-statement')
  mini(
    @CurrentUser() user: JwtPayload,
    @Query('accountNumber') accountNumber: string,
    @Query('n') n?: string,
  ) {
    return this.accounts.miniStatement(user.customerId, accountNumber, n ? Number(n) : 10);
  }

  @Get('portfolio')
  portfolio(@CurrentUser() user: JwtPayload) {
    return this.accounts.portfolio(user.customerId);
  }
}
