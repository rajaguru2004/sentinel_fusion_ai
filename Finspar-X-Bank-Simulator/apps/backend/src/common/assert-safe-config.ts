import { Logger } from '@nestjs/common';
import { env } from './env';

/**
 * Fail the boot rather than run a demo affordance in production.
 *
 * This codebase deliberately carries several "make the demo legible" switches —
 * a fixed OTP, a client-supplied country header, an unauthenticated Playwright
 * runner. Each is individually documented and individually safe *because it is
 * off by default*, but nothing until now stopped a production deploy from
 * inheriting one from a copied .env.
 *
 * In development these are logged as warnings so the posture is visible on every
 * boot. In production they are fatal.
 */
export function assertSafeConfig(): void {
  const log = new Logger('Config');

  const unsafe: string[] = [];
  if (env.otpDemoMode) unsafe.push('OTP_DEMO_MODE — OTP is the fixed value 123456, not a secret');
  if (env.geo.allowMockCountry) unsafe.push('GEO_ALLOW_MOCK_COUNTRY — clients can spoof their country via X-Mock-Country');
  if (env.demo.testRunnerEnabled) unsafe.push('DEMO_TEST_RUNNER — unauthenticated endpoint spawns Playwright processes');
  if (env.geo.devUsePublicIp) unsafe.push('GEO_DEV_USE_PUBLIC_IP — geo resolves the server egress IP, not the client');
  if (env.auth.allowBearer) unsafe.push('AUTH_ALLOW_BEARER — JWT accepted from a header, weakening the httpOnly cookie');
  if (env.jwtSecret === 'dev_only_change_me') unsafe.push('JWT_SECRET is the built-in development default');
  if (!env.auth.cookieSecure) unsafe.push('AUTH_COOKIE_SECURE=false — the session cookie may travel over plaintext');

  if (!unsafe.length) return;

  if (env.isProduction) {
    throw new Error(
      'Refusing to start in production with demo/development settings enabled:\n' +
        unsafe.map((u) => `  - ${u}`).join('\n'),
    );
  }

  log.warn('Development posture — the following are NOT safe for production:');
  for (const u of unsafe) log.warn(`  - ${u}`);
}
