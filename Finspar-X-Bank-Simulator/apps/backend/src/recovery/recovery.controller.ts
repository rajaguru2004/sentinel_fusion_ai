import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RecoveryService } from './recovery.service';
import {
  ForgotUserIdDto,
  ForgotPasswordRequestDto,
  ResetPasswordDto,
  UnlockRequestDto,
  OtpVerifyDto,
  ResendDto,
} from './dto/recovery.dto';

@ApiTags('recovery')
@Controller('auth')
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Post('forgot-user-id')
  forgotUserId(@Body() dto: ForgotUserIdDto) {
    return this.recovery.forgotUserId(dto.customerId, dto.email, dto.mobile);
  }

  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordRequestDto) {
    return this.recovery.forgotPasswordRequest(dto.customerId, dto.userId, dto.purpose);
  }

  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.recovery.resetPassword(dto.requestId, dto.code, dto.newPassword);
  }

  @Post('unlock')
  unlock(@Body() dto: UnlockRequestDto) {
    return this.recovery.unlockRequest(dto.customerId, dto.userId);
  }

  @Post('unlock/verify')
  unlockVerify(@Body() dto: OtpVerifyDto) {
    return this.recovery.unlockVerify(dto.requestId, dto.code);
  }

  @Post('recovery/resend')
  resend(@Body() dto: ResendDto) {
    return this.recovery.resend(dto.requestId);
  }
}
