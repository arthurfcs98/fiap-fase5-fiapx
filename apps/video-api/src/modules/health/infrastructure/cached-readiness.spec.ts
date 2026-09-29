import { ServiceUnavailableException } from '@nestjs/common';
import { CachedReadiness } from './cached-readiness';

describe('CachedReadiness', () => {
  it('reuses the result for the TTL and shares concurrent evaluations', async () => {
    let now = 0;
    const check = jest.fn().mockResolvedValue({ status: 'ok' });
    const readiness = new CachedReadiness(check, 2_000, () => now);

    await expect(Promise.all([readiness.isReady(), readiness.isReady()])).resolves.toEqual([
      true,
      true,
    ]);
    now = 1_999;
    await expect(readiness.isReady()).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(1);

    now = 2_000;
    check.mockRejectedValueOnce(new ServiceUnavailableException({ status: 'error' }));
    await expect(readiness.isReady()).resolves.toBe(false);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('unexpected errors propagate (and are not cached)', async () => {
    const check = jest.fn().mockRejectedValueOnce(new TypeError('bug')).mockResolvedValue({});
    const readiness = new CachedReadiness(check);

    await expect(readiness.isReady()).rejects.toThrow('bug');
    await expect(readiness.isReady()).resolves.toBe(true);
  });
});
