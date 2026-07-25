/** Typed environment access. Fails fast if a required secret is missing. */

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
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
  get otpTtlSeconds(): number {
    return Number(optional('OTP_TTL_SECONDS', '100'));
  },
  get otpMaxAttempts(): number {
    return Number(optional('OTP_MAX_ATTEMPTS', '3'));
  },
  get loginMaxAttempts(): number {
    return Number(optional('LOGIN_MAX_ATTEMPTS', '5'));
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
