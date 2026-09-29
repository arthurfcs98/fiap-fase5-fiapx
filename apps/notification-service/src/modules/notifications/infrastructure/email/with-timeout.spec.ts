import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('resolves with the promise when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, () => new Error('late'))).resolves.toBe(
      'ok',
    );
  });

  it('propagates the promise rejection', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1_000, () => new Error('late')),
    ).rejects.toThrow('boom');
  });

  it('rejects with onTimeout() when the promise takes too long', async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withTimeout(never, 10, () => new Error('no answer in 10 ms'))).rejects.toThrow(
      'no answer in 10 ms',
    );
  });
});
