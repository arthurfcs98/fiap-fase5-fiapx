import { Logger } from '@nestjs/common';
import { FailOpenThrottlerStorage } from './fail-open-throttler.storage';

describe('FailOpenThrottlerStorage', () => {
  const record = { totalHits: 3, timeToExpire: 10, isBlocked: true, timeToBlockExpire: 5 };

  it('delegates to the Redis storage', async () => {
    const inner = { increment: jest.fn().mockResolvedValue(record) };
    const storage = new FailOpenThrottlerStorage(inner);

    await expect(storage.increment('k', 60_000, 5, 60_000, 'default')).resolves.toBe(record);
    expect(inner.increment).toHaveBeenCalledWith('k', 60_000, 5, 60_000, 'default');
  });

  it('lets the request through when Redis fails and logs at most once a minute', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let now = 0;
    const inner = {
      increment: jest
        .fn()
        .mockRejectedValueOnce(new Error('Connection is closed.'))
        .mockRejectedValueOnce('offline')
        .mockRejectedValueOnce(new Error('again')),
    };
    const storage = new FailOpenThrottlerStorage(inner, () => now);

    const allowed = { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    await expect(storage.increment('k', 1, 1, 1, 'default')).resolves.toEqual(allowed);
    now = 30_000;
    await expect(storage.increment('k', 1, 1, 1, 'default')).resolves.toEqual(allowed);
    now = 61_000;
    await expect(storage.increment('k', 1, 1, 1, 'default')).resolves.toEqual(allowed);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ error: 'Connection is closed.' }),
    );
    expect(warn).toHaveBeenNthCalledWith(2, expect.objectContaining({ error: 'again' }));
  });

  it('uses the wall clock by default', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const storage = new FailOpenThrottlerStorage({ increment: jest.fn().mockRejectedValue('x') });
    await expect(storage.increment('k', 1, 1, 1, 'default')).resolves.toMatchObject({
      isBlocked: false,
    });
  });
});
