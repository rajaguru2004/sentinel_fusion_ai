import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ThrottleTier } from '../common/throttler.config';
import type { Request, Response } from 'express';
import { env } from '../common/env';
import { SkipCsrf, clearCsrfCookie, newCsrfToken, setCsrfCookie } from '../common/csrf';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto, ChangeTxnPasswordDto, UpdateProfileDto } from './dto/password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { JwtPayload } from './jwt.strategy';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Credential submission — the tightest tier. The per-user lockout already caps
  // guesses against one account; this caps the request volume behind them and
  // stops one guess being sprayed across many user ids from a single source.
  //
  // SkipCsrf: login is where the CSRF token is *minted*, so there is nothing to
  // echo back yet. It is not CSRF-reachable in any meaningful sense either —
  // forging a login for the victim's browser using the attacker's own
  // credentials gains the attacker nothing.
  @ThrottleTier('auth')
  @SkipCsrf()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      mockCountry: req.headers['x-mock-country'] as string | undefined,
    });

    // The token now travels in an httpOnly cookie (§4) — script on the page
    // cannot read it, so an XSS cannot exfiltrate the session.
    res.cookie(env.auth.cookieName, result.accessToken, {
      httpOnly: true,
      secure: env.auth.cookieSecure,
      sameSite: env.auth.cookieSameSite,
      path: '/',
      maxAge: env.jwtExpiresInMs,
    });
    const csrfToken = newCsrfToken();
    setCsrfCookie(res, csrfToken);

    // accessToken is still returned while AUTH_ALLOW_BEARER is on, for the
    // Swagger console and the API test suite. In production that flag is off and
    // the field is omitted, so the cookie is the only carrier that exists.
    const { accessToken, ...rest } = result;
    return { ...rest, csrfToken, ...(env.auth.allowBearer ? { accessToken } : {}) };
  }

  /** Drop the session and CSRF cookies. Safe to call when already logged out. */
  @SkipCsrf()
  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(env.auth.cookieName, { path: '/' });
    clearCsrfCookie(res);
    return { message: 'Signed out' };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return user;
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('profile')
  profile(@CurrentUser() user: JwtPayload) {
    return this.auth.getProfile(user.sub, user.customerId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('profile')
  async updateProfile(@CurrentUser() user: JwtPayload, @Body() dto: UpdateProfileDto) {
    const updated = await this.auth.updateProfile(user.sub, dto.password, {
      mobile: dto.mobile,
      email: dto.email,
    });
    return { message: 'Profile updated', ...updated };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(@CurrentUser() user: JwtPayload, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(user.sub, dto.oldPassword, dto.newPassword);
    return { message: 'Password updated' };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('change-txn-password')
  async changeTxnPassword(@CurrentUser() user: JwtPayload, @Body() dto: ChangeTxnPasswordDto) {
    await this.auth.changeTxnPassword(user.sub, dto.oldPassword, dto.newPassword);
    return { message: 'Transaction password updated' };
  }
}
