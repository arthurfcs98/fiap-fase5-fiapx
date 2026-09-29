import { Logger } from '@nestjs/common';
import {
  cacheKey,
  IDEMPOTENCY_TTL_SECONDS,
  RedisIdempotencyCache,
} from './redis-idempotency.cache';

describe('RedisIdempotencyCache', () => {
  it('stores and reads the video id under a hashed key with a 24 h TTL', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: jest.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve('OK' as const);
      }),
    };
    const cache = new RedisIdempotencyCache(redis);

    await expect(cache.get('u1', 'k1')).resolves.toBeUndefined();
    await cache.remember('u1', 'k1', 'v1');
    await expect(cache.get('u1', 'k1')).resolves.toBe('v1');

    expect(redis.set).toHaveBeenCalledWith(
      cacheKey('u1', 'k1'),
      'v1',
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
    );
    expect(cacheKey('u1', 'k1')).toMatch(/^fiapx:idem:u1:[0-9a-f]{64}$/);
  });

  it('never throws: Redis failures fall back to Postgres', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const redis = {
      get: jest.fn().mockRejectedValue(new Error('down')),
      set: jest.fn().mockRejectedValue('down'),
    };
    const cache = new RedisIdempotencyCache(redis);

    await expect(cache.get('u1', 'k1')).resolves.toBeUndefined();
    await expect(cache.remember('u1', 'k1', 'v1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
