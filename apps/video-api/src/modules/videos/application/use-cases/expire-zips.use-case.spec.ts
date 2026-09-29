import { Logger } from '@nestjs/common';
import { InMemoryObjectStorage } from '@fiapx/storage/testing';
import { aVideo, FakeUnitOfWork, FixedClock, NOW } from '../../../../../test/support/fakes';
import type { VideoSettings } from '../video.settings';
import {
  ExpireZipsUseCase,
  ZIP_RETENTION_BATCH,
  ZIP_RETENTION_LOCK,
  ZIP_RETENTION_MAX_BATCHES,
} from './expire-zips.use-case';

const DAY = 24 * 60 * 60 * 1000;
const settings = { zipRetentionDays: 7 } as VideoSettings;
const OLD = '11111111-1111-4111-8111-111111111111';
const RECENT = '22222222-2222-4222-8222-222222222222';

async function setup() {
  const uow = new FakeUnitOfWork();
  const storage = new InMemoryObjectStorage();
  for (const [id, age] of [
    [OLD, 8 * DAY],
    [RECENT, 2 * DAY],
  ] as const) {
    uow.videos.add(
      aVideo({
        id,
        status: 'COMPLETED',
        zipKey: `u/${id}.zip`,
        completedAt: new Date(NOW.getTime() - age),
      }),
    );
    await storage.putStream({ bucket: 'fiapx-zips', key: `u/${id}.zip`, body: Buffer.from('zip') });
  }
  return {
    uow,
    storage,
    useCase: new ExpireZipsUseCase(
      uow,
      storage,
      { raw: 'fiapx-raw', zips: 'fiapx-zips' },
      settings,
      new FixedClock(),
    ),
  };
}

describe('ExpireZipsUseCase (LGPD retention)', () => {
  it('deletes zips older than ZIP_RETENTION_DAYS and marks zip_key NULL + expired_at', async () => {
    const { uow, storage, useCase } = await setup();

    await expect(useCase.execute()).resolves.toEqual({ skipped: false, expired: 1, failed: 0 });

    expect(storage.contentOf('fiapx-zips', `u/${OLD}.zip`)).toBeUndefined();
    expect(storage.contentOf('fiapx-zips', `u/${RECENT}.zip`)).toBeDefined();
    expect(uow.videos.snapshot(OLD)).toMatchObject({
      status: 'COMPLETED',
      zipKey: null,
      expiredAt: NOW,
    });
    expect(uow.videos.snapshot(RECENT)).toMatchObject({ expiredAt: null });
  });

  it('skips when another replica holds the advisory lock', async () => {
    const { uow, storage, useCase } = await setup();
    uow.heldLocks.add(ZIP_RETENTION_LOCK);
    await expect(useCase.execute()).resolves.toEqual({ skipped: true, expired: 0, failed: 0 });
    expect(storage.size).toBe(2);
  });

  it('a storage failure keeps the row for the next run', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { uow, storage, useCase } = await setup();
    storage.failNext('delete');
    await expect(useCase.execute()).resolves.toEqual({ skipped: false, expired: 0, failed: 1 });
    expect(uow.videos.snapshot(OLD)).toMatchObject({ zipKey: `u/${OLD}.zip`, expiredAt: null });
    jest.spyOn(storage, 'delete').mockRejectedValueOnce('down');
    await expect(useCase.execute()).resolves.toMatchObject({ failed: 1 });
  });

  it('keeps going while batches come back full (a backlog is drained in one run)', async () => {
    const { uow, storage, useCase } = await setup();
    const extra = ZIP_RETENTION_BATCH + 10;
    for (let i = 0; i < extra; i += 1) {
      const id = `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`;
      uow.videos.add(
        aVideo({
          id,
          status: 'COMPLETED',
          zipKey: `u/${id}.zip`,
          completedAt: new Date(NOW.getTime() - 9 * DAY),
        }),
      );
      await storage.putStream({ bucket: 'fiapx-zips', key: `u/${id}.zip`, body: Buffer.from('z') });
    }

    await expect(useCase.execute()).resolves.toEqual({
      skipped: false,
      expired: extra + 1,
      failed: 0,
    });
    expect(uow.runs).toBe(2);
    expect(ZIP_RETENTION_MAX_BATCHES).toBe(20);
  });

  it('stops after a batch with storage failures (the next run retries)', async () => {
    const { uow, storage, useCase } = await setup();
    for (let i = 0; i < ZIP_RETENTION_BATCH; i += 1) {
      const id = `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`;
      uow.videos.add(
        aVideo({
          id,
          status: 'COMPLETED',
          zipKey: `u/${id}.zip`,
          completedAt: new Date(NOW.getTime() - 9 * DAY),
        }),
      );
    }
    storage.failNext('delete');

    const summary = await useCase.execute();

    expect(summary.failed).toBe(1);
    expect(uow.runs).toBe(1);
  });
});
