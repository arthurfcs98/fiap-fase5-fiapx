import { FIXTURE_USER_ID } from '@fiapx/contracts/fixtures';
import { Logger } from '@nestjs/common';
import type { INotificationRepository } from '../../domain/ports/notification.repository';
import { AnonymizeUserNotificationsUseCase } from './anonymize-user-notifications.use-case';

describe('AnonymizeUserNotificationsUseCase', () => {
  it('anonymizes the notifications of the deleted user and logs only ids and the count', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const repository = {
      anonymizeByUser: jest.fn().mockResolvedValue(3),
    } as unknown as INotificationRepository;

    await expect(
      new AnonymizeUserNotificationsUseCase(repository).execute(FIXTURE_USER_ID),
    ).resolves.toBe(3);

    expect(repository.anonymizeByUser).toHaveBeenCalledWith(FIXTURE_USER_ID);
    expect(log).toHaveBeenCalledWith({
      msg: 'Notifications of the deleted user anonymized',
      userId: FIXTURE_USER_ID,
      anonymized: 3,
    });
  });

  it('propagates database failures (the queue retries the event)', async () => {
    const repository = {
      anonymizeByUser: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as INotificationRepository;

    await expect(
      new AnonymizeUserNotificationsUseCase(repository).execute(FIXTURE_USER_ID),
    ).rejects.toThrow('db down');
  });
});
