import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type JwtFromRequestFunction } from 'passport-jwt';
import type { Request } from 'express';
import { env } from '../common/env';

export interface JwtPayload {
  sub: string; // User.id
  userId: string; // human user id e.g. TARAKESH
  customerId: string; // Customer.id (selected at login)
  customerRef: string; // human customer id e.g. 83840226
  role: string;
}

/**
 * Pull the JWT out of the httpOnly session cookie (ENHANCEMENTS.md §4).
 *
 * This is the primary carrier: because the cookie is httpOnly, no script on the
 * page — injected or otherwise — can read the token, which removes XSS as a path
 * to account takeover.
 */
const fromCookie: JwtFromRequestFunction = (req: Request) => {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[env.auth.cookieName] ?? null;
};

/**
 * Cookie first, then `Authorization: Bearer` if AUTH_ALLOW_BEARER is on.
 *
 * The bearer path exists for callers that cannot hold cookies — the Swagger
 * console and the Playwright API suite. It defaults on in development and off in
 * production, where the cookie must be the only accepted carrier (otherwise the
 * httpOnly guarantee is decorative: stolen-token replay works again).
 */
function extractor(): JwtFromRequestFunction {
  if (!env.auth.allowBearer) return fromCookie;
  return ExtractJwt.fromExtractors([fromCookie, ExtractJwt.fromAuthHeaderAsBearerToken()]);
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: extractor(),
      ignoreExpiration: false,
      secretOrKey: env.jwtSecret,
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    return payload;
  }
}
