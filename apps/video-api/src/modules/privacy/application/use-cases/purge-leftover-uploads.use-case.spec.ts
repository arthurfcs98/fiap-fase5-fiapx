import { InMemoryObjectStorage } from '@fiapx/storage/testing';
import { Logger } from '@nestjs/common';
import {
  aVideo,
  FakeUnitOfWork,
  FixedClock,
  NOW,
  USER_ID,
} from '../../../../../test/support/fakes';
import type { StoredObjectInfo, UserObjectStore } from '../../domain/user-object.store';
import {
  LEFTOVER_MIN_AGE_MS,
  LEFTOVER_SWEEP_LOCK,
  PurgeLeftoverUploadsUseCase,
} from './purge-leftover-uploads.use-case';

const ids = {
  completed: '11111111-1111-4111-8111-111111111111',
  failed: '22222222-2222-4222-8222-222222222222',
  queued: '33333333-3333-4333-8333-333333333333',
  orphanOld: '44444444-4444-4444-8444-444444444444',
  orphanNew: '55555555-5555-4555-8555-555555555555',
};
const OLD = new Date(NOW.getTime() - LEFTOVER_MIN_AGE_MS - 1);
const NEW = new Date(NOW.getTime() - 1_000);

function setup(listing: StoredObjectInfo[]) {
  const uow = new FakeUnitOfWork();
  uow.videos.add(aVideo({ id: ids.completed, status: 'COMPLETED' }));
  uow.videos.add(aVideo({ id: ids.failed, status: 'FAILED' }));
  uow.videos.add(aVideo({ id: ids.queued, status: 'QUEUED' }));
  const storage = new InMemoryObjectStorage();
  const objects: jest.Mocked<UserObjectStore> = {
    listOwnerIds: jest.fn(),
    deleteAllOf: jest.fn(),
    listObjects: jest.fn().mockResolvedValue(listing),
    abortIncompleteUploads: jest.fn().mockResolvedValue(1),
  };
  const useCase = new PurgeLeftoverUploadsUseCase(
    uow,
    objects,
    storage,
    { raw: 'fiapx-raw', zips: 'fiapx-zips' },
    new FixedClock(),
  );
  return { uow, storage, objects, useCase };
}

const raw = (videoId: string, lastModified?: Date): StoredObjectInfo => ({
  key: `${USER_ID}/${videoId}.mp4`,
  lastModified,
});

describe('PurgeLeftoverUploadsUseCase (LGPD safety net of the originals)', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterAll(() => {
    Logger.overrideLogger(new Logger());
  });

  it('deletes originals of finished videos and old ones without a row; keeps work in progress', async () => {
    const listing = [
      raw(ids.completed, NEW),
      raw(ids.failed, NEW),
      raw(ids.queued, OLD),
      raw(ids.orphanOld, OLD),
      raw(ids.orphanNew, NEW),
      raw(ids.orphanNew.replace('5555', '6666')),
      { key: 'lixo-sem-padrao.txt', lastModified: OLD },
    ];
    const { storage, objects, useCase } = setup(listing);
    for (const { key } of listing) {
      await storage.putStream({ bucket: 'fiapx-raw', key, body: Buffer.from('x') });
    }

    await expect(useCase.execute()).resolves.toEqual({
      skipped: false,
      rawDeleted: 3,
      uploadsAborted: 2,
    });

    const kept = listing.filter(({ key }) => storage.contentOf('fiapx-raw', key) !== undefined);
    expect(kept.map(({ key }) => key)).toEqual([
      raw(ids.queued).key,
      raw(ids.orphanNew).key,
      raw(ids.orphanNew.replace('5555', '6666')).key,
      'lixo-sem-padrao.txt',
    ]);
    const cutoff = new Date(NOW.getTime() - LEFTOVER_MIN_AGE_MS);
    expect(objects.abortIncompleteUploads.mock.calls).toEqual([
      ['fiapx-raw', cutoff],
      ['fiapx-zips', cutoff],
    ]);
  });

  it('skips when another replica holds the lock', async () => {
    const { uow, objects, useCase } = setup([]);
    uow.heldLocks.add(LEFTOVER_SWEEP_LOCK);

    await expect(useCase.execute()).resolves.toEqual({
      skipped: true,
      rawDeleted: 0,
      uploadsAborted: 0,
    });
    expect(objects.listObjects).not.toHaveBeenCalled();
  });

  it('nothing to clean: no log, zero counts', async () => {
    const { objects, useCase } = setup([]);
    objects.abortIncompleteUploads.mockResolvedValue(0);

    await expect(useCase.execute()).resolves.toEqual({
      skipped: false,
      rawDeleted: 0,
      uploadsAborted: 0,
    });
  });
});
