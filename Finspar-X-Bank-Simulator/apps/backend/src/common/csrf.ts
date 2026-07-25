import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from './env';

/** Cookie holding the CSRF token. Readable by JS — that is the whole point. */
export const CSRF_COOKIE = 'finspark_csrf';
/** Header the frontend must echo it back on. */
export const CSRF_HEADER = 'x-csrf-token';

/** Opt a route out of CSRF (login itself, and unauthenticated recovery routes). */
export const SKIP_CSRF = 'skipCsrf';
export const SkipCsrf = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_CSRF, true);

/** Methods that cannot change state, so cannot be a CSRF target. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function newCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Issue the CSRF cookie alongside the session cookie.
 *
 * Deliberately NOT httpOnly: the frontend has to read it to echo it back in a
 * header. That is safe, because the defence does not rest on the token being
 * secret from the user's own page — it rests on a *cross-origin* page being
 * unable to read it (same-origin policy) and therefore unable to set the header.
 */
export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: env.auth.cookieSecure,
    sameSite: env.auth.cookieSameSite,
    path: '/',
  });
}

export function clearCsrfCookie(res: Response): void {
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

/** Constant-time compare that tolerates unequal lengths without leaking them. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Double-submit CSRF guard (ENHANCEMENTS.md §4).
 *
 * Moving the JWT into an httpOnly cookie removes the XSS token-theft risk, but
 * buys a new one: the browser now attaches credentials to *any* request to this
 * origin, including one triggered by a form on an attacker's page. `SameSite`
 * blocks most of that, but it is a single point of failure (browser support,
 * a future `SameSite=lax` relaxation for a cross-site SPA host), so the token
 * check is layered underneath it.
 *
 * The check: a token is minted at login and written to a JS-readable cookie. A
 * legitimate frontend reads it and echoes it in `X-CSRF-Token`. An attacker's
 * page can cause the cookie to be *sent* but cannot *read* it, so it cannot
 * produce a matching header.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    // Bearer callers (Swagger, the Playwright API suite) are not cookie-driven,
    // so they are not CSRF-reachable: a cross-origin page cannot set an
    // Authorization header. Only exempt them when bearer auth is actually
    // enabled — in production AUTH_ALLOW_BEARER is off and this never fires.
    if (env.auth.allowBearer && req.headers.authorization?.startsWith('Bearer ')) return true;

    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken = req.headers[CSRF_HEADER];

    if (!cookieToken || typeof headerToken !== 'string' || !safeEqual(cookieToken, headerToken)) {
      throw new ForbiddenException('CSRF token missing or invalid');
    }
    return true;
  }
}
