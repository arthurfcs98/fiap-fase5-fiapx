import { Logger } from '@nestjs/common';
import type { OutboxStore } from '../../../outbox/domain/outbox.ports';
import {
  aUser,
  FakeUnitOfWork,
  FixedClock,
  InMemoryProcessedMessages,
  NOW,
  OTHER_USER_ID,
  USER_ID,
} from '../../../../../test/support/fakes';
import type { UserObjectStore } from '../../domain/user-object.store';
import {
  PROCESSED_MESSAGES_RETENTION_DAYS,
  PUBLISHED_OUTBOX_RETENTION_DAYS,
  PurgeDeliveryRecordsUseCase,
} from './purge-delivery-records.use-case';
import { ORPHAN_SWEEP_LOCK, PurgeOrphanObjectsUseCase } from './purge-orphan-objects.use-case';

const buckets = { raw: 'fiapx-raw', zips: 'fiapx-zips' };
const DAY = 24 * 60 * 60 * 1000;

describe('PurgeOrphanObjectsUseCase', () => {
  function setup() {
    const uow = new FakeUnitOfWork();
    uow.users.users.set(USER_ID, aUser());
    const store: jest.Mocked<UserObjectStore> = {
      listOwnerIds: jest.fn((bucket: string) =>
        Promise.resolve(
          bucket === 'fiapx-raw' ? [USER_ID, OTHER_USER_ID, 'not-a-user'] : [OTHER_USER_ID],
        ),
      ),
      deleteAllOf: jest.fn().mockResolvedValue(2),
      listObjects: jest.fn().mockResolvedValue([]),
      abortIncompleteUploads: jest.fn().mockResolvedValue(0),
    };
    return { uow, store, useCase: new PurgeOrphanObjectsUseCase(uow, store, buckets) };
  }

  it('deletes only the prefixes of users that no longer exist (UUID prefixes only)', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { store, useCase } = setup();

    await expect(useCase.execute()).resolves.toEqual({ skipped: false, owners: 2, objects: 4 });
    expect(store.deleteAllOf.mock.calls).toEqual([
      ['fiapx-raw', OTHER_USER_ID],
      ['fiapx-zips', OTHER_USER_ID],
    ]);
  });

  it('skips when another replica holds the lock; nothing to delete is silent', async () => {
    const { uow, store, useCase } = setup();
    uow.heldLocks.add(ORPHAN_SWEEP_LOCK);
    await expect(useCase.execute()).resolves.toEqual({ skipped: true, owners: 0, objects: 0 });
    uow.heldLocks.clear();
    store.listOwnerIds.mockResolvedValue([USER_ID]);
    await expect(useCase.execute()).resolves.toEqual({ skipped: false, owners: 0, objects: 0 });
  });
});

describe('PurgeDeliveryRecordsUseCase', () => {
  it('purges published outbox rows after 7 days and inbox rows after 14 days', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const outbox = {
      purgePublishedBefore: jest.fn().mockResolvedValue(3),
    } as unknown as OutboxStore;
    const inbox = new InMemoryProcessedMessages();

    await expect(
      new PurgeDeliveryRecordsUseCase(outbox, inbox, new FixedClock()).execute(),
    ).resolves.toEqual({
      outbox: 3,
      processedMessages: 0,
    });
    expect(outbox.purgePublishedBefore).toHaveBeenCalledWith(
      new Date(NOW.getTime() - PUBLISHED_OUTBOX_RETENTION_DAYS * DAY),
    );
    expect(inbox.purgedBefore).toEqual(
      new Date(NOW.getTime() - PROCESSED_MESSAGES_RETENTION_DAYS * DAY),
    );
  });

  it('logs nothing when there is nothing to purge', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const outbox = {
      purgePublishedBefore: jest.fn().mockResolvedValue(0),
    } as unknown as OutboxStore;
    await new PurgeDeliveryRecordsUseCase(
      outbox,
      new InMemoryProcessedMessages(),
      new FixedClock(),
    ).execute();
    expect(log).not.toHaveBeenCalled();
  });
});
