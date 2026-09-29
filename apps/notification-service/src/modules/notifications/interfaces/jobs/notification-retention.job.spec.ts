import { getCorrelationId } from '@fiapx/observability';
import { Logger } from '@nestjs/common';
import type { ApplyNotificationRetentionUseCase } from '../../application/use-cases/apply-notification-retention.use-case';
import { NotificationRetentionJob } from './notification-retention.job';

function job(execute: () => Promise<number | null>): NotificationRetentionJob {
  return new NotificationRetentionJob({ execute } as unknown as ApplyNotificationRetentionUseCase);
}

describe('NotificationRetentionJob', () => {
  it('runs the retention use case inside a fresh correlation context', async () => {
    let correlationId: string | undefined;
    const retention = jest.fn(() => {
      correlationId = getCorrelationId();
      return Promise.resolve(7);
    });

    await expect(job(retention).run()).resolves.toBe(7);

    expect(retention).toHaveBeenCalledTimes(1);
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs a failure (redacted) instead of crashing the scheduler', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(
      job(() => Promise.reject(new Error('db down (fiapx@example.com)'))).run(),
    ).resolves.toBeNull();

    expect(error).toHaveBeenCalledWith({
      msg: 'Notification retention failed',
      error: 'Error: db down ([email])',
    });
  });
});
