import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/** How often (at most) a Redis outage is logged while requests are let through. */
const LOG_EVERY_MS = 60_000;

/**
 * Wraps the Redis throttler storage so a Redis outage does not turn every throttled route into
 * a 500 (the storage propagates the ioredis error). While Redis is down the request is allowed
 * (fail-open): throttling is abuse protection, not a correctness requirement, and login/upload
 * keep working.
 */
export class FailOpenThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('Throttler');
  private lastLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly inner: ThrottlerStorage,
    private readonly now: () => number = Date.now,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.inner.increment(key, ttl, limit, blockDuration, throttlerName);
    } catch (error) {
      this.logOutage(error);
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  private logOutage(error: unknown): void {
    const now = this.now();
    if (now - this.lastLoggedAt < LOG_EVERY_MS) return;
    this.lastLoggedAt = now;
    this.logger.warn({
      msg: 'Redis indisponível: throttling liberado (fail-open)',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
