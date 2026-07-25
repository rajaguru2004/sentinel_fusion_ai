/** Typed environment access. Fails fast if a required secret is missing. */

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * A rate-limit count from env. `0` means "no limit" — @nestjs/throttler treats
 * Infinity as unlimited, so an operator can switch a tier off during a demo or
 * load test without a code change. A malformed value falls back to the default
 * rather than silently becoming 0, which would disable the limit by typo.
 */
function limitFrom(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n === 0 ? Number.POSITIVE_INFINITY : n;
}

export const env = {
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  get jwtSecret(): string {
    return optional('JWT_SECRET', 'dev_only_change_me');
  },
  get jwtExpiresIn(): string {
    return optional('JWT_EXPIRES_IN', '15m');
  },
  /**
   * JWT_EXPIRES_IN as milliseconds, for the session cookie's Max-Age so the
   * cookie expires exactly when the token it carries does. Supports the `ms`
   * shorthand the JWT library accepts (`15m`, `2h`, `7d`, or bare seconds).
   */
  get jwtExpiresInMs(): number {
    const raw = this.jwtExpiresIn.trim();
    const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(raw);
    if (!m) return 15 * 60_000;
    const n = Number(m[1]);
    switch (m[2]) {
      case 'ms':
        return n;
      case 'h':
        return n * 3_600_000;
      case 'd':
        return n * 86_400_000;
      case 'm':
        return n * 60_000;
      // Bare number = seconds, matching the JWT spec's `expiresIn`.
      default:
        return n * 1000;
    }
  },
  get otpTtlSeconds(): number {
    return Number(optional('OTP_TTL_SECONDS', '100'));
  },
  get otpMaxAttempts(): number {
    return Number(optional('OTP_MAX_ATTEMPTS', '3'));
  },
  get loginMaxAttempts(): number {
    return Number(optional('LOGIN_MAX_ATTEMPTS', '5'));
  },
  get isProduction(): boolean {
    return optional('NODE_ENV', 'development') === 'production';
  },
  /**
   * DEMO ONLY. Makes the OTP a fixture instead of a secret: `issue()` returns a
   * fixed `123456` and the requestId is a short 4–5 digit number so it can be
   * typed by hand on stage. Everything around it stays real (bcrypt hash, TTL,
   * attempt burn, resend cooldown) — only the values are predictable.
   *
   * Defaults ON so existing demo scripts keep working, but a production boot
   * (NODE_ENV=production) refuses to start with it enabled — see assertSafeConfig().
   */
  get otpDemoMode(): boolean {
    return optional('OTP_DEMO_MODE', 'true') === 'true';
  },
  auth: {
    /** Name of the httpOnly cookie carrying the JWT. */
    get cookieName(): string {
      return optional('AUTH_COOKIE_NAME', 'finspark_session');
    },
    /**
     * `Secure` on the session cookie. Must be true in production; false for
     * local http://localhost development or the browser drops the cookie.
     */
    get cookieSecure(): boolean {
      return optional('AUTH_COOKIE_SECURE', String(optional('NODE_ENV', 'development') === 'production')) === 'true';
    },
    /**
     * SameSite policy. `strict` is right when frontend and API share a site.
     * Use `lax` if the SPA is served from a different host than the API.
     */
    get cookieSameSite(): 'strict' | 'lax' | 'none' {
      return optional('AUTH_COOKIE_SAMESITE', 'strict') as 'strict' | 'lax' | 'none';
    },
    /**
     * Accept `Authorization: Bearer` in addition to the cookie. Needed by the
     * Swagger console and the Playwright API suite, which cannot hold cookies.
     * Turn OFF in production so the cookie is the only accepted carrier.
     */
    get allowBearer(): boolean {
      return optional('AUTH_ALLOW_BEARER', String(optional('NODE_ENV', 'development') !== 'production')) === 'true';
    },
  },
  throttle: {
    /**
     * Optional Redis backing for the rate limiter. Unset = in-process memory,
     * which is only correct while exactly one backend instance runs.
     * Example: redis://localhost:6379
     */
    get redisUrl(): string {
      return optional('THROTTLE_REDIS_URL', '');
    },
    /**
     * Requests per minute per IP, by tier. Raise these rather than editing
     * throttler.config.ts. Set any of them to 0 to disable that tier entirely
     * (useful when a demo or load test is fighting the limiter).
     *
     * The default tier is deliberately high: the analyst console polls ~22
     * req/min while merely sitting open, before any user action.
     */
    get defaultLimit(): number {
      return limitFrom('THROTTLE_DEFAULT_LIMIT', 600);
    },
    get authLimit(): number {
      return limitFrom('THROTTLE_AUTH_LIMIT', 20);
    },
    get issueLimit(): number {
      return limitFrom('THROTTLE_ISSUE_LIMIT', 10);
    },
    get moneyLimit(): number {
      return limitFrom('THROTTLE_MONEY_LIMIT', 120);
    },
  },
  smtp: {
    get host(): string {
      return optional('SMTP_HOST', 'smtp.zoho.in');
    },
    get port(): number {
      return Number(optional('SMTP_PORT', '465'));
    },
    get secure(): boolean {
      return optional('SMTP_SECURE', 'true') === 'true';
    },
    get user(): string {
      return optional('EMAIL_USER', '');
    },
    get pass(): string {
      return optional('EMAIL_PASS', '');
    },
    get to(): string {
      return optional('EMAIL_USER_TO', '');
    },
  },
  // Sentinel Fusion AI — the ML scoring service (Phase 2). When `enabled`, the
  // HttpScorer replaces the HeuristicScorer behind the SCORER token; on any model
  // error/timeout it fails open to the heuristic so the money path never hangs.
  sentinel: {
    get enabled(): boolean {
      return optional('SENTINEL_ENABLED', 'false') === 'true';
    },
    get url(): string {
      // Backend runs in Docker: host.docker.internal reaches the model on the host.
      return optional('SENTINEL_URL', 'http://host.docker.internal:8000');
    },
    get apiKey(): string {
      return optional('SENTINEL_API_KEY', 'sentinel-demo-key-2026');
    },
    get timeoutMs(): number {
      return Number(optional('SENTINEL_TIMEOUT_MS', '800'));
    },
  },
  // Risk-alert email. Every scored event at or above `minLevel` mails the
  // CUSTOMER the event belongs to — no batching, no throttling: one event, one
  // mail. Sent fire-and-forget off the money path so SMTP latency never delays
  // a payment.
  riskAlert: {
    get enabled(): boolean {
      return optional('RISK_ALERT_ENABLED', 'true') === 'true';
    },
    /**
     * From header on alert mail. Empty (the default) means "send as the
     * authenticated mailbox", i.e. EMAIL_USER — which is what every provider
     * expects. Set RISK_ALERT_FROM only to an address the SMTP account is
     * actually allowed to send as (a verified alias / Send-As), or the provider
     * rejects the message.
     */
    get from(): string {
      return optional('RISK_ALERT_FROM', '') || this.smtpUser;
    },
    /**
     * Fallback recipient, used ONLY when the scored event has no resolvable
     * customer email (no userId, or the user row is gone). Comma-separated.
     * The normal recipient is the customer's own address. Defaults to the
     * sending mailbox so an alert is never addressed to nobody.
     */
    get fallbackTo(): string {
      return optional('RISK_ALERT_FALLBACK_TO', '') || this.smtpUser;
    },
    /** Nested objects cannot see the outer `env`; read the mailbox directly. */
    get smtpUser(): string {
      return optional('EMAIL_USER', '');
    },
    /** LOW | MEDIUM | HIGH | CRITICAL — lowest band that triggers a mail. */
    get minLevel(): string {
      return optional('RISK_ALERT_MIN_LEVEL', 'MEDIUM').toUpperCase();
    },
  },
  geo: {
    // DEV ONLY. Browser->localhost traffic is loopback (127.0.0.1), so a VPN is
    // invisible to req.ip. When true, a private/loopback client IP falls back to
    // geolocating the machine's PUBLIC egress IP (which DOES go through the VPN),
    // so local testing reflects your real / VPN country. Never enable in prod —
    // there the real client IP arrives via X-Forwarded-For.
    get devUsePublicIp(): boolean {
      return optional('GEO_DEV_USE_PUBLIC_IP', 'false') === 'true';
    },
    // DEV ONLY. Honour an `X-Mock-Country` request header (the login page's mock-
    // VPN selector) as the client's country, overriding geo-IP. NEVER enable in
    // prod — trusting a client-supplied country lets an attacker spoof location
    // to dodge the new-country fraud signal.
    get allowMockCountry(): boolean {
      return optional('GEO_ALLOW_MOCK_COUNTRY', 'false') === 'true';
    },
    /**
     * Countries considered the bank's home market. Requests from any other
     * country trigger the gateway policy rule (floor to CHALLENGE) regardless
     * of what the ML model scored. Comma-separated ISO alpha-2 codes.
     * Default: IN (India-only bank).
     * Example: GEO_ALLOWED_COUNTRIES=IN,SG,AE
     */
    get allowedCountries(): Set<string> {
      return new Set(
        optional('GEO_ALLOWED_COUNTRIES', 'IN')
          .split(',')
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean),
      );
    },
  },
  demo: {
    // DEMO ONLY. Mounts /api/demo-tests/*, which spawns Playwright on request
    // for the login-page test panel. The routes are unauthenticated (the panel
    // is pre-auth and EventSource cannot send headers), so the flag, the fixed
    // spec allowlist and argv-array exec are the only things standing between a
    // caller and a spawned process. NEVER enable outside a demo machine.
    get testRunnerEnabled(): boolean {
      return optional('DEMO_TEST_RUNNER', 'false') === 'true';
    },
  },
};
