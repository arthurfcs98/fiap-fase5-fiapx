import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { videoUploadedEvent } from '@fiapx/contracts';
import { StorageQuotaExceededError } from '@fiapx/storage';
import { InMemoryObjectStorage } from '@fiapx/storage/testing';
import {
  aVideo,
  FakeUnitOfWork,
  FixedClock,
  MapIdempotencyCache,
  NOW,
  RecordingVideoMetrics,
  USER_ID,
  VIDEO_ID,
} from '../../../../../test/support/fakes';
import { mp4Bytes, pngBytes } from '../../../../../test/support/media';
import { FileTypeSignatureInspector } from '../../infrastructure/file-signature/file-type-signature.inspector';
import { DuplicateIdempotencyKeyError } from '../../domain/video.repository';
import type { VideoSettings } from '../video.settings';
import { UploadVideoUseCase } from './upload-video.use-case';

const buckets = { raw: 'fiapx-raw', zips: 'fiapx-zips' };
const settings = { maxPendingVideosPerUser: 2 } as VideoSettings;

function setup() {
  const uow = new FakeUnitOfWork();
  const storage = new InMemoryObjectStorage();
  const cache = new MapIdempotencyCache();
  const metrics = new RecordingVideoMetrics();
  const useCase = new UploadVideoUseCase(
    uow,
    uow.videos,
    storage,
    buckets,
    new FileTypeSignatureInspector(),
    cache,
    metrics,
    new FixedClock(),
    settings,
  );
  return { uow, storage, cache, metrics, useCase };
}

const upload = (name: string, bytes: Buffer, extra: Record<string, unknown> = {}) => ({
  userId: USER_ID,
  correlationId: 'cid-upload-1',
  file: { originalName: name, stream: Readable.from([bytes]) },
  ...extra,
});

describe('UploadVideoUseCase', () => {
  describe('assertWithinPendingLimit (MAX_PENDING_VIDEOS_PER_USER)', () => {
    it('counts QUEUED/PROCESSING videos plus uploads still streaming', async () => {
      const { uow, useCase } = setup();
      await expect(useCase.assertWithinPendingLimit(USER_ID, 1)).resolves.toBeUndefined();

      uow.videos.add(aVideo({ status: 'QUEUED' }));
      await expect(useCase.assertWithinPendingLimit(USER_ID, 0)).resolves.toBeUndefined();
      await expect(useCase.assertWithinPendingLimit(USER_ID, 1)).rejects.toMatchObject({
        appError: { code: 'V0007', httpStatus: 429, metadata: { limit: 2, retryAfterSeconds: 15 } },
      });
    });

    it('finished videos do not count', async () => {
      const { uow, useCase } = setup();
      uow.videos.add(aVideo({ id: '00000000-0000-4000-8000-000000000001', status: 'COMPLETED' }));
      uow.videos.add(aVideo({ id: '00000000-0000-4000-8000-000000000002', status: 'FAILED' }));

      await expect(useCase.assertWithinPendingLimit(USER_ID, 1)).resolves.toBeUndefined();
    });
  });

  it('fiapx-raw full (quota) → 503 X0003 with a longer Retry-After, nothing committed', async () => {
    const { uow, storage, useCase } = setup();
    storage.failNext('put', new StorageQuotaExceededError('put', 'fiapx-raw', undefined));

    await expect(useCase.execute(upload('demo.mp4', mp4Bytes(2048)))).rejects.toMatchObject({
      appError: { code: 'X0003', metadata: { retryAfterSeconds: 30 } },
    });
    expect(uow.outbox.events).toEqual([]);
  });

  it('streams to fiapx-raw and commits video + history + outbox video.uploaded in one transaction', async () => {
    const { uow, storage, cache, metrics, useCase } = setup();
    const bytes = mp4Bytes(4096);

    const accepted = await useCase.execute(
      upload('Férias 2026.MP4', bytes, { idempotencyKey: 'k-1' }),
    );

    expect(accepted).toEqual({
      id: expect.any(String),
      originalName: 'Férias 2026.MP4',
      status: 'QUEUED',
    });
    const rawKey = `${USER_ID}/${accepted.id}.mp4`;
    expect(storage.contentOf('fiapx-raw', rawKey)).toEqual(bytes);
    expect(uow.videos.snapshot(accepted.id)).toMatchObject({
      status: 'QUEUED',
      rawKey,
      sizeBytes: bytes.length,
      contentType: 'video/mp4',
      idempotencyKey: 'k-1',
      createdAt: NOW,
    });
    expect(uow.videos.history).toEqual([
      expect.objectContaining({ videoId: accepted.id, fromStatus: null, toStatus: 'QUEUED' }),
    ]);
    const [event] = uow.outbox.ofType('video.uploaded');
    expect(videoUploadedEvent.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      correlationId: 'cid-upload-1',
      payload: {
        videoId: accepted.id,
        userId: USER_ID,
        originalName: 'Férias 2026.MP4',
        rawBucket: 'fiapx-raw',
        rawKey,
        zipBucket: 'fiapx-zips',
        zipKey: `${USER_ID}/${accepted.id}.zip`,
        sizeBytes: bytes.length,
      },
    });
    expect(uow.runs).toBe(1);
    expect(metrics.uploadedCount).toBe(1);
    await expect(cache.get(USER_ID, 'k-1')).resolves.toBe(accepted.id);
  });

  it('unsupported extension → 400 V0002 before touching the storage', async () => {
    const { storage, useCase } = setup();
    await expect(useCase.execute(upload('playlist.m3u8', mp4Bytes()))).rejects.toMatchObject({
      appError: { code: 'V0002', httpStatus: 400 },
    });
    expect(storage.size).toBe(0);
  });

  it('magic bytes of another format (PNG renamed to .mp4) → 400 V0002', async () => {
    const { storage, uow, useCase } = setup();
    await expect(useCase.execute(upload('foto.mp4', pngBytes()))).rejects.toMatchObject({
      appError: { code: 'V0002' },
    });
    expect(storage.size).toBe(0);
    expect(uow.runs).toBe(0);
  });

  it('storage down → 503 X0003 with Retry-After, nothing persisted', async () => {
    const { storage, uow, useCase } = setup();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    storage.failNext('put');

    await expect(useCase.execute(upload('a.mp4', mp4Bytes()))).rejects.toMatchObject({
      appError: { code: 'X0003', httpStatus: 503, metadata: { retryAfterSeconds: 5 } },
    });
    expect(uow.runs).toBe(0);
  });

  it('aborted by the HTTP layer (size limit / client gone) → the original error, no 503', async () => {
    const { useCase } = setup();
    const controller = new AbortController();
    controller.abort(new Error('limit'));

    await expect(
      useCase.execute(upload('a.mp4', mp4Bytes(), { signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'ObjectStorageError' });
  });

  it('non-storage errors of the PUT propagate', async () => {
    const { storage, useCase } = setup();
    jest.spyOn(storage, 'putStream').mockRejectedValue(new TypeError('bug'));
    await expect(useCase.execute(upload('a.mp4', mp4Bytes()))).rejects.toThrow('bug');
  });

  it('database failure → the stored object is deleted (no orphan) and the error propagates', async () => {
    const { storage, uow, useCase } = setup();
    jest.spyOn(uow.videos, 'insert').mockRejectedValue(new Error('db down'));

    await expect(useCase.execute(upload('a.mp4', mp4Bytes()))).rejects.toThrow('db down');
    expect(storage.size).toBe(0);
    expect(uow.outbox.events).toHaveLength(0);
  });

  it('a failing cleanup is only logged', async () => {
    const { storage, uow, useCase } = setup();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(uow.videos, 'insert').mockRejectedValue(new Error('db down'));
    jest.spyOn(storage, 'delete').mockRejectedValue('storage down');

    await expect(useCase.execute(upload('a.mp4', mp4Bytes()))).rejects.toThrow('db down');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ error: 'storage down' }));
  });

  it('concurrent retry with the same Idempotency-Key → returns the video that won the race', async () => {
    const { storage, uow, useCase } = setup();
    uow.videos.add(aVideo({ idempotencyKey: 'k-1', status: 'PROCESSING' }));
    jest.spyOn(uow.videos, 'insert').mockRejectedValueOnce(new DuplicateIdempotencyKeyError());

    await expect(
      useCase.execute(upload('a.mp4', mp4Bytes(), { idempotencyKey: 'k-1' })),
    ).resolves.toEqual({ id: VIDEO_ID, originalName: 'demo.mp4', status: 'PROCESSING' });
    expect(storage.size).toBe(0);
  });

  it('duplicate key without a surviving row propagates the error', async () => {
    const { uow, useCase } = setup();
    jest.spyOn(uow.videos, 'insert').mockRejectedValueOnce(new DuplicateIdempotencyKeyError());
    await expect(
      useCase.execute(upload('a.mp4', mp4Bytes(), { idempotencyKey: 'k-9' })),
    ).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
  });

  it('user deleted while uploading → 401 A0003 and the object is removed', async () => {
    const { storage, uow, useCase } = setup();
    uow.videos.owners = new Set();

    await expect(useCase.execute(upload('a.mp4', mp4Bytes()))).rejects.toMatchObject({
      appError: { code: 'A0003' },
    });
    expect(storage.size).toBe(0);
  });

  describe('findReplay (Idempotency-Key checked before reading the body)', () => {
    it('hits the Redis cache first', async () => {
      const { uow, cache, useCase } = setup();
      uow.videos.add(aVideo({ idempotencyKey: 'k-1' }));
      await cache.remember(USER_ID, 'k-1', VIDEO_ID);
      const byKey = jest.spyOn(uow.videos, 'findByIdempotencyKey');

      await expect(useCase.findReplay(USER_ID, 'k-1')).resolves.toEqual({
        id: VIDEO_ID,
        originalName: 'demo.mp4',
        status: 'QUEUED',
      });
      expect(byKey).not.toHaveBeenCalled();
    });

    it('falls back to the unique index in Postgres', async () => {
      const { uow, useCase } = setup();
      uow.videos.add(aVideo({ idempotencyKey: 'k-1' }));
      await expect(useCase.findReplay(USER_ID, 'k-1')).resolves.toMatchObject({ id: VIDEO_ID });
    });

    it('is scoped by user and returns null for a new key', async () => {
      const { uow, cache, useCase } = setup();
      uow.videos.add(aVideo({ idempotencyKey: 'k-1' }));
      await cache.remember('someone-else', 'k-1', VIDEO_ID);
      await expect(useCase.findReplay('someone-else', 'k-1')).resolves.toBeNull();
      await expect(useCase.findReplay(USER_ID, 'k-2')).resolves.toBeNull();
    });
  });
});
