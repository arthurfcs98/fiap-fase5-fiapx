import { RedisLifecycle } from './redis-lifecycle.service';

describe('RedisLifecycle', () => {
  it('closes the client on shutdown', async () => {
    const redis = {
      status: 'ready',
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    };
    await new RedisLifecycle(redis as never).onApplicationShutdown();
    expect(redis.quit).toHaveBeenCalled();
  });
});
