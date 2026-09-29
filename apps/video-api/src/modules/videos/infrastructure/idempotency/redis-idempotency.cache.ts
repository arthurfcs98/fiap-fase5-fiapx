import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { IdempotencyCache } from '../../application/ports/idempotency.cache';

/** How long a key → video id mapping stays in Redis (the index in Postgres is permanent). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * Redis cache of `Idempotency-Key` → video id (`fiapx:idem:<userId>:<sha256(key)>`). Every
 * failure is swallowed: with Redis down the lookup falls back to the unique index in Postgres.
 */
export class RedisIdempotencyCache implements IdempotencyCache {
  private readonly logger = new Logger(RedisIdempotencyCache.name);

  constructor(private readonly redis: Pick<Redis, 'get' | 'set'>) {}

  async get(userId: string, idempotencyKey: string): Promise<string | undefined> {
    try {
      return (await this.redis.get(cacheKey(userId, idempotencyKey))) ?? undefined;
    } catch (error) {
      this.warn('leitura', error);
      return undefined;
    }
  }

  async remember(userId: string, idempotencyKey: string, videoId: string): Promise<void> {
    try {
      await this.redis.set(
        cacheKey(userId, idempotencyKey),
        videoId,
        'EX',
        IDEMPOTENCY_TTL_SECONDS,
      );
    } catch (error) {
      this.warn('escrita', error);
    }
  }

  private warn(operation: string, error: unknown): void {
    this.logger.warn({
      msg: `Cache de Idempotency-Key indisponível (${operation}); usando o Postgres`,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function cacheKey(userId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return `fiapx:idem:${userId}:${digest}`;
}
