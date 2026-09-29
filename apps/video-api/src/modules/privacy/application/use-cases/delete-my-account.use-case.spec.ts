import { userDeletedEvent } from '@fiapx/contracts';
import { videoCompletedFixture } from '@fiapx/contracts/fixtures';
import { Logger } from '@nestjs/common';
import {
  aUser,
  aVideo,
  FakePasswordHasher,
  FakeUnitOfWork,
  USER_ID,
  VIDEO_ID,
} from '../../../../../test/support/fakes';
import type { UserObjectStore } from '../../domain/user-object.store';
import { DeleteMyAccountUseCase } from './delete-my-account.use-case';

const buckets = { raw: 'fiapx-raw', zips: 'fiapx-zips' };

function setup(objects: Partial<UserObjectStore> = {}) {
  const uow = new FakeUnitOfWork();
  uow.users.users.set(USER_ID, aUser());
  uow.videos.add(aVideo());
  void uow.videos.appendHistory(VIDEO_ID, { from: null, to: 'QUEUED', reason: 'r' }, new Date());
  const store: UserObjectStore = {
    listOwnerIds: jest.fn().mockResolvedValue([]),
    deleteAllOf: jest.fn((bucket: string) => Promise.resolve(bucket === 'fiapx-raw' ? 1 : 2)),
    ...objects,
  };
  const useCase = new DeleteMyAccountUseCase(
    uow.users,
    new FakePasswordHasher(),
    uow,
    store,
    buckets,
  );
  return { uow, store, useCase };
}

const input = { userId: USER_ID, password: 'senha-forte-123', correlationId: 'cid-lgpd' };

describe('DeleteMyAccountUseCase (LGPD art. 18 VI)', () => {
  it('deletes history, videos and user, drops their outbox rows and writes user.deleted in ONE transaction', async () => {
    const { uow, store, useCase } = setup();
    // A pending/published video event of the user (payload with e-mail and name).
    await uow.outbox.add(videoCompletedFixture, VIDEO_ID);

    await expect(useCase.execute(input)).resolves.toEqual({
      deletedVideos: 1,
      deletedObjects: 3,
      objectsPending: false,
    });

    expect(uow.runs).toBe(1);
    expect(uow.users.users.size).toBe(0);
    expect(uow.videos.videos.size).toBe(0);
    expect(uow.videos.history).toHaveLength(0);
    expect(uow.outbox.deletedAggregates).toEqual([VIDEO_ID, USER_ID]);
    expect(uow.outbox.events).toHaveLength(1);
    const [event] = uow.outbox.ofType('user.deleted');
    expect(userDeletedEvent.parse(event)).toEqual(event);
    expect(event).toMatchObject({ correlationId: 'cid-lgpd', payload: { userId: USER_ID } });
    expect(uow.outbox.events[0]?.aggregateId).toBe(USER_ID);
    expect(store.deleteAllOf).toHaveBeenCalledWith('fiapx-raw', USER_ID);
    expect(store.deleteAllOf).toHaveBeenCalledWith('fiapx-zips', USER_ID);
  });

  it('wrong password → 400 A0004 and nothing is deleted (the session stays valid)', async () => {
    const { uow, useCase } = setup();
    await expect(useCase.execute({ ...input, password: 'errada' })).rejects.toMatchObject({
      appError: { code: 'A0004', httpStatus: 400 },
    });
    expect(uow.users.users.size).toBe(1);
    expect(uow.runs).toBe(0);
  });

  it('already deleted → 401 A0003 (also when it disappears before the lock)', async () => {
    const { uow, useCase } = setup();
    jest.spyOn(uow.users, 'lockById').mockResolvedValueOnce(null);
    await expect(useCase.execute(input)).rejects.toMatchObject({ appError: { code: 'A0003' } });
    expect(uow.videos.videos.size).toBe(1);

    uow.users.users.clear();
    await expect(useCase.execute(input)).rejects.toMatchObject({ appError: { code: 'A0003' } });
  });

  it('storage failure after the commit → 204 anyway, the hourly sweep finishes the job', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { uow, useCase } = setup({
      deleteAllOf: jest.fn((bucket: string) =>
        bucket === 'fiapx-zips' ? Promise.reject(new Error('down')) : Promise.resolve(1),
      ),
    });
    await expect(useCase.execute(input)).resolves.toEqual({
      deletedVideos: 1,
      deletedObjects: 1,
      objectsPending: true,
    });
    expect(uow.users.users.size).toBe(0);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, bucket: 'fiapx-zips' }),
    );
  });

  it('non-Error storage failures are logged as text', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { useCase } = setup({ deleteAllOf: jest.fn().mockRejectedValue('timeout') });
    await useCase.execute(input);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ error: 'timeout' }));
  });
});
