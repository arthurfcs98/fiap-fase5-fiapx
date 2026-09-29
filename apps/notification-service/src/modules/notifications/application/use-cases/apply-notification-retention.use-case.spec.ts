import { Logger } from '@nestjs/common';
import type { INotificationRepository } from '../../domain/ports/notification.repository';
import { ApplyNotificationRetentionUseCase } from './apply-notification-retention.use-case';

const NOW = new Date('2026-10-31T03:00:00.000Z');
const SETTINGS = {
  publicBaseUrl: 'https://x',
  notifyOnSuccess: false,
  retentionDays: 30,
  dailyLimitPerUser: 10,
  dailyLimit: 80,
};

function repositoryReturning(value: number | null): INotificationRepository {
  return {
    anonymizeCreatedBefore: jest.fn().mockResolvedValue(value),
  } as unknown as INotificationRepository;
}

describe('ApplyNotificationRetentionUseCase', () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  it('anonymizes notifications older than NOTIFICATION_RETENTION_DAYS', async () => {
    const repository = repositoryReturning(4);

    await expect(
      new ApplyNotificationRetentionUseCase(repository, SETTINGS).execute(NOW),
    ).resolves.toBe(4);

    expect(repository.anonymizeCreatedBefore).toHaveBeenCalledWith(
      new Date('2026-10-01T03:00:00.000Z'),
    );
    expect(log).toHaveBeenCalledWith({
      msg: 'Notification retention applied',
      retentionDays: 30,
      cutoff: '2026-10-01T03:00:00.000Z',
      anonymized: 4,
    });
  });

  it('returns null when another replica holds the lock', async () => {
    const repository = repositoryReturning(null);

    await expect(
      new ApplyNotificationRetentionUseCase(repository, {
        ...SETTINGS,
        retentionDays: 1,
      }).execute(),
    ).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith({
      msg: 'Notification retention skipped: another replica holds the lock',
    });
  });

  it('uses the current time by default', async () => {
    const repository = repositoryReturning(0);
    const before = Date.now();

    await new ApplyNotificationRetentionUseCase(repository, SETTINGS).execute();

    const cutoff = (repository.anonymizeCreatedBefore as jest.Mock).mock.calls[0][0] as Date;
    const expected = before - 30 * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expected);
    expect(cutoff.getTime()).toBeLessThan(expected + 5_000);
  });
});
