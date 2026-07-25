import { Logger, type OnModuleDestroy } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';

/**
 * Redis-backed rate-limit storage (ENHANCEMENTS.md §2, gap 3).
 *
 * Written directly against ioredis rather than pulling in a community adapter:
 * those declare peer dependencies on @nestjs/common and @nestjs/core, which
 * makes npm hoist those two packages to the workspace root while leaving their
 * siblings nested. Nest resolves its optional packages (platform-express,
 * class-validator) relative to @nestjs/common, so that split silently breaks the
 * ValidationPipe and the HTTP adapter. Forty lines here avoids a dependency that
 * rearranges the module tree underneath the whole backend.
 *
 * The increment is a Lua script so the INCR and the TTL are one atomic
 * round-trip. Doing them as separate commands leaves a window where a crash
 * between the two produces a key with no expiry — a counter that never resets
 * and locks the caller out permanently.
 */
const INCR_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { hits, ttl }
`;

export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly log = new Logger(RedisThrottlerStorage.name);
  private readonly redis: Redis;
  /** Set when Redis is unreachable, so we fail OPEN rather than block traffic. */
  private degraded = false;

  constructor(url: string) {
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 2,
      // A rate limiter must not add latency to the money path when its store is
      // sick; give up fast and let the request through.
      connectTimeout: 500,
      lazyConnect: false,
    });
    this.redis.on('error', (e) => {
      if (!this.degraded) {
        this.degraded = true;
        this.log.error(`Rate-limit store unavailable (${e.message}) — failing OPEN`);
      }
    });
    this.redis.on('ready', () => {
      if (this.degraded) this.log.log('Rate-limit store recovered');
      this.degraded = false;
    });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = `throttle:${throttlerName}:${key}`;
    try {
      const [hits, pttl] = (await this.redis.eval(INCR_SCRIPT, 1, redisKey, ttl)) as [number, number];

      const isBlocked = hits > limit;
      if (isBlocked && blockDuration > ttl) {
        // Extend the key for the block window so the caller stays locked out
        // past the natural counting window.
        await this.redis.pexpire(redisKey, blockDuration);
      }
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(Math.max(pttl, 0) / 1000),
        isBlocked,
        timeToBlockExpire: isBlocked ? Math.ceil(Math.max(pttl, 0) / 1000) : 0,
      };
    } catch (e) {
      // FAIL OPEN, matching the fraud scorer's posture: an unavailable limiter
      // must degrade to "no limiting", never to "no service". Reporting one hit
      // keeps the caller under every limit.
      this.log.warn(`Rate-limit check failed (${String(e)}) — allowing request`);
      return { totalHits: 1, timeToExpire: Math.ceil(ttl / 1000), isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
