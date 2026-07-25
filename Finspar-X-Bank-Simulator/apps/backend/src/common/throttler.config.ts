import { Logger } from '@nestjs/common';
import { Throttle, type ThrottlerModuleOptions } from '@nestjs/throttler';
import { RedisThrottlerStorage } from './redis-throttler-storage';
import { env } from './env';

/**
 * Request-level rate limiting (ENHANCEMENTS.md §2).
 *
 * The per-credential caps that already exist (OTP attempt burn, login lockout)
 * throttle a single challenge or a single user row. They do NOT cap how many
 * challenges a caller can issue, and they do not stop one guess sprayed across
 * many user ids. These tiers are that missing layer.
 *
 * IMPORTANT — why there is exactly ONE throttler registered.
 *
 * ThrottlerGuard loops over EVERY throttler configured in forRoot() and applies
 * all of them to every route (`for (const namedThrottler of this.throttlers)`).
 * Registering four named tiers therefore does not let a route pick one — it
 * subjects every route to all four at once, so the tightest tier silently
 * governs the whole API. That is exactly what happened: a 3/min tier meant for
 * password-reset mail was throttling reads, beneficiary activation and payment
 * release after three requests.
 *
 * So: one throttler named `default`, and routes tighten it with
 * `@ThrottleTier('auth')`, which overrides that same throttler's limit for the
 * route it decorates. One limit applies to any given request, and it is the one
 * named on the handler.
 */
export const THROTTLE_TIERS = {
  /**
   * Everything not otherwise annotated. Generous on purpose: the analyst console
   * alone polls four queries at 15s plus scoring health at 10s (~22 req/min
   * while idle), and normal navigation fans out further. This tier exists to
   * stop runaway automation, not to police ordinary use.
   */
  default: { limit: env.throttle.defaultLimit, ttl: 60_000 },
  /** Credential submission: login, password reset, unlock verify. */
  auth: { limit: env.throttle.authLimit, ttl: 60_000 },
  /** Routes that MINT a credential or send mail — the expensive ones. */
  issue: { limit: env.throttle.issueLimit, ttl: 60_000 },
  /** State-changing money operations: confirm, submit. */
  money: { limit: env.throttle.moneyLimit, ttl: 60_000 },
} as const;

export type ThrottleTierName = keyof typeof THROTTLE_TIERS;

/**
 * Apply a named tier to a route.
 *
 * Overrides the `default` throttler's limit for this handler, rather than
 * registering an additional throttler — see the note above for why that
 * distinction matters.
 */
export const ThrottleTier = (tier: ThrottleTierName): MethodDecorator & ClassDecorator =>
  Throttle({ default: THROTTLE_TIERS[tier] });

/**
 * Storage backing.
 *
 * Default is in-process memory, which is correct for this stack as shipped —
 * docker-compose.yml runs exactly one backend container, so a per-process
 * counter IS the global counter.
 *
 * Limits surviving a restart and holding across replicas needs shared state:
 * set THROTTLE_REDIS_URL and the limiter moves to Redis with no other change.
 * Do that before running more than one backend instance, or an attacker gets
 * `limit × replicas` attempts per window.
 */
export function throttlerOptions(): ThrottlerModuleOptions {
  const throttlers = [{ name: 'default', ...THROTTLE_TIERS.default }];
  const log = new Logger('Throttler');
  const tiers = Object.entries(THROTTLE_TIERS)
    .map(([n, t]) => `${n}=${t.limit}/min`)
    .join(' ');

  const url = env.throttle.redisUrl;
  if (!url) {
    log.log(`Rate limiting active (in-memory, single instance): ${tiers}`);
    return { throttlers };
  }
  log.log(`Rate limiting active (Redis at ${url}): ${tiers}`);
  return { throttlers, storage: new RedisThrottlerStorage(url) };
}
