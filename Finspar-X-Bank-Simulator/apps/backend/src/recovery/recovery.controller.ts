import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ThrottleTier } from '../common/throttler.config';
import { SkipCsrf } from '../common/csrf';
import { RecoveryService } from './recovery.service';
import {
  ForgotUserIdDto,
  ForgotPasswordRequestDto,
  ResetPasswordDto,
  UnlockRequestDto,
  OtpVerifyDto,
  ResendDto,
} from './dto/recovery.dto';

/**
 * Unauthenticated account-recovery surface. Every route here either mints a
 * credential, sends mail, or accepts one — so all of them carry an explicit
 * throttle tier (§2). The `issue` tier is the tightest: those routes cost an
 * outbound email per call.
 */
// SkipCsrf on the whole controller: these routes are reached by a logged-OUT
// visitor who has no session and therefore no CSRF cookie to echo. There is no
// ambient authority to abuse — every route re-proves identity from the body
// (customerId + userId, or a mailed OTP), so a forged cross-origin request
// accomplishes exactly what an attacker could accomplish by calling it directly.
// The `issue`/`auth` throttle tiers above are the real control here.
@SkipCsrf()
@ApiTags('recovery')
@Controller('auth')
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @ThrottleTier('issue')
  @Post('forgot-user-id')
  forgotUserId(@Body() dto: ForgotUserIdDto) {
    return this.recovery.forgotUserId(dto.customerId, dto.email, dto.mobile);
  }

  @ThrottleTier('issue')
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordRequestDto) {
    return this.recovery.forgotPasswordRequest(dto.customerId, dto.userId, dto.purpose);
  }

  @ThrottleTier('auth')
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.recovery.resetPassword(dto.requestId, dto.code, dto.newPassword);
  }

  @ThrottleTier('issue')
  @Post('unlock')
  unlock(@Body() dto: UnlockRequestDto) {
    return this.recovery.unlockRequest(dto.customerId, dto.userId);
  }

  @ThrottleTier('auth')
  @Post('unlock/verify')
  unlockVerify(@Body() dto: OtpVerifyDto) {
    return this.recovery.unlockVerify(dto.requestId, dto.code);
  }

  @ThrottleTier('issue')
  @Post('recovery/resend')
  resend(@Body() dto: ResendDto) {
    return this.recovery.resend(dto.requestId);
  }
}
