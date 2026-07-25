import type { APIRequestContext } from '@playwright/test';
import { BACKEND, CREDS } from './env';

export interface Session {
  token: string;
  user: {
    userId: string;
    customerId: string;
    customerName: string;
    role: 'MAKER' | 'AUTHORIZER' | 'VIEWER';
    email: string;
    mobile: string;
    lastLoginAt: string | null;
  };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Log in over the API.
 *
 * NOTE: every call produces a scored LOGIN FraudEvent — AuthService.login awaits
 * FraudGateway.assess before returning the token. So "read the newest LOGIN from
 * the feed" is self-poisoning if you log in again in between. Fetch once, reuse.
 *
 * `captcha` is omitted deliberately: LoginDto marks it @IsOptional() and it is
 * never validated server-side (the check lives entirely in the login page).
 */
export async function apiLogin(
  request: APIRequestContext,
  userId: string,
  password: string,
  mockCountry?: string,
): Promise<Session> {
  const res = await request.post(`${BACKEND}/api/auth/login`, {
    headers: {
      'Content-Type': 'application/json',
      ...(mockCountry ? { 'X-Mock-Country': mockCountry } : {}),
    },
    data: {
      customerId: CREDS.customerId,
      userId,
      password,
      deviceFingerprint: `e2e/${userId}`,
    },
  });
  if (!res.ok()) {
    throw new Error(`login ${userId} -> HTTP ${res.status()}: ${await res.text()}`);
  }
  // The API returns { accessToken, user } — normalise to `token` so callers and
  // seedSession() (which writes localStorage['finspark-token']) agree. Reading
  // `.token` off the raw response silently yields undefined and every
  // subsequent request 401s with a misleading "Unauthorized".
  const body = (await res.json()) as { accessToken: string; user: Session['user'] };
  return { token: body.accessToken, user: body.user };
}

/**
 * The seed and the demo doc disagree about PRIYA_A's password, and a password
 * changed through the UI survives reseeding. Try the candidates in order.
 * Deliberately bounded — LOGIN_MAX_ATTEMPTS is 5 and a lockout is worse than a
 * failed test.
 */
export async function resolveAuthorizerPassword(request: APIRequestContext): Promise<string> {
  const tried: string[] = [];
  for (const pw of CREDS.authorizerPasswords.slice(0, 3)) {
    tried.push(pw);
    const res = await request.post(`${BACKEND}/api/auth/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: { customerId: CREDS.customerId, userId: CREDS.authorizerId, password: pw },
    });
    if (res.ok()) return pw;
  }
  throw new Error(
    `${CREDS.authorizerId} rejected every candidate password (${tried.join(', ')}).\n` +
      `  prisma/seed.ts hashes 'Finspark@123'; DEMO_PRESENTATION.md §4 says 'NewPass@999'.\n` +
      `  Fix: npm run db:seed, or set E2E_AUTHORIZER_PASSWORD.\n` +
      `  Careful: LOGIN_MAX_ATTEMPTS=5 locks the account — use /unlock if that happens.`,
  );
}

export const feed = async (
  request: APIRequestContext,
  token: string,
  limit = 30,
): Promise<any[]> =>
  (await request.get(`${BACKEND}/api/analyst/feed?limit=${limit}`, { headers: auth(token) })).json();

export const held = async (request: APIRequestContext, token: string): Promise<any[]> =>
  (await request.get(`${BACKEND}/api/analyst/held`, { headers: auth(token) })).json();

/** Newest LOGIN fraud event not already seen. Poll-friendly (returns null). */
export async function newestLogin(
  request: APIRequestContext,
  token: string,
  exclude: Set<string>,
): Promise<any | null> {
  const rows = await feed(request, token, 30);
  return rows.find((e) => e.eventType === 'LOGIN' && !exclude.has(e.id)) ?? null;
}
