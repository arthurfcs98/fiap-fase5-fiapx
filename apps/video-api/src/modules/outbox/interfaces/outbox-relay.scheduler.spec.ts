import { Logger } from '@nestjs/common';
import { FixedClock } from '../../../../test/support/fakes';
import type { OutboxRelay } from '../application/outbox-relay';
import { OutboxRelayScheduler } from './outbox-relay.scheduler';

function relay(...results: Array<{ claimed: number; published: number; failed: number } | Error>) {
  const relayBatch = jest.fn();
  for (const result of results) {
    if (result instanceof Error) relayBatch.mockRejectedValueOnce(result);
    else relayBatch.mockResolvedValueOnce(result);
  }
  relayBatch.mockResolvedValue({ claimed: 0, published: 0, failed: 0 });
  return { relayBatch } as unknown as jest.Mocked<OutboxRelay>;
}

describe('OutboxRelayScheduler', () => {
  it('keeps draining while full batches are published, then waits for the next tick', async () => {
    const outbox = relay(
      { claimed: 50, published: 50, failed: 0 },
      { claimed: 3, published: 3, failed: 0 },
    );
    await new OutboxRelayScheduler(outbox, new FixedClock()).tick();
    expect(outbox.relayBatch).toHaveBeenCalledTimes(2);
  });

  it('stops the tick on a publish failure', async () => {
    const outbox = relay({ claimed: 50, published: 10, failed: 1 });
    await new OutboxRelayScheduler(outbox, new FixedClock()).tick();
    expect(outbox.relayBatch).toHaveBeenCalledTimes(1);
  });

  it('never runs two ticks at once', async () => {
    let release: () => void = () => undefined;
    const relayBatch = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ claimed: 0, published: 0, failed: 0 });
        }),
    );
    const scheduler = new OutboxRelayScheduler(
      { relayBatch } as unknown as OutboxRelay,
      new FixedClock(),
    );
    const first = scheduler.tick();
    const second = scheduler.tick();
    release();
    await Promise.all([first, second]);
    expect(relayBatch).toHaveBeenCalledTimes(1);
  });

  it('logs a database outage once a minute and the recovery once', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const clock = new FixedClock();
    const outbox = relay(new Error('db down'), new Error('db down'), new Error('db down'));
    const scheduler = new OutboxRelayScheduler(outbox, clock);

    await scheduler.tick();
    clock.advance(10_000);
    await scheduler.tick();
    clock.advance(60_000);
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ error: 'db down' }));
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('non-Error failures are logged as text', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const relayBatch = jest.fn().mockRejectedValue('boom');
    await new OutboxRelayScheduler(
      { relayBatch } as unknown as OutboxRelay,
      new FixedClock(),
    ).tick();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ error: 'boom' }));
  });

  it('on shutdown waits for the batch in flight and stops ticking', async () => {
    let release: () => void = () => undefined;
    const relayBatch = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ claimed: 50, published: 50, failed: 0 });
        }),
    );
    const scheduler = new OutboxRelayScheduler(
      { relayBatch } as unknown as OutboxRelay,
      new FixedClock(),
    );
    const tick = scheduler.tick();
    const destroyed = scheduler.onModuleDestroy();
    release();
    await Promise.all([tick, destroyed]);
    await scheduler.tick();
    expect(relayBatch).toHaveBeenCalledTimes(1);
  });
});
