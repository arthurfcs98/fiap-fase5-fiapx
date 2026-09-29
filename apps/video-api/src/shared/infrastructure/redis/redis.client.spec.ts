import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { attachErrorLogger, closeRedisClient, createRedisClient } from './redis.client';

describe('redis client helpers', () => {
  it('creates a lazy-failing client (no offline queue) with an error listener', async () => {
    const client = createRedisClient('redis://:secret@127.0.0.1:1', 'video-api');
    try {
      expect(client).toBeInstanceOf(Redis);
      expect(client.options.enableOfflineQueue).toBe(false);
      expect(client.options.maxRetriesPerRequest).toBe(1);
      expect(client.options.connectionName).toBe('video-api');
      expect(client.listenerCount('error')).toBe(1);
      const retry = client.options.retryStrategy as (attempt: number) => number;
      expect(retry(1)).toBe(250);
      expect(retry(100)).toBe(5_000);
    } finally {
      client.disconnect();
    }
    await closeRedisClient(client);
  });

  it('logs connection errors at most once a minute', () => {
    const emitter = new EventEmitter();
    const logger = { warn: jest.fn() };
    let now = 0;
    attachErrorLogger(emitter as never, logger, () => now);

    emitter.emit('error', new Error('ECONNREFUSED'));
    now = 10_000;
    emitter.emit('error', new Error('ECONNREFUSED'));
    now = 70_000;
    emitter.emit('error', new Error('ETIMEDOUT'));

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith({ msg: 'Redis indisponível', error: 'ETIMEDOUT' });
  });

  it('quits gracefully and falls back to disconnect', async () => {
    const ok = { status: 'ready', quit: jest.fn().mockResolvedValue('OK'), disconnect: jest.fn() };
    await closeRedisClient(ok as never);
    expect(ok.quit).toHaveBeenCalled();
    expect(ok.disconnect).not.toHaveBeenCalled();

    const broken = {
      status: 'reconnecting',
      quit: jest.fn().mockRejectedValue(new Error('x')),
      disconnect: jest.fn(),
    };
    await closeRedisClient(broken as never);
    expect(broken.disconnect).toHaveBeenCalled();

    const ended = { status: 'end', quit: jest.fn(), disconnect: jest.fn() };
    await closeRedisClient(ended as never);
    expect(ended.quit).not.toHaveBeenCalled();
  });
});
