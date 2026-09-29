import { RetryableError } from '@fiapx/common';
import type { ProcessingEvent } from '@fiapx/contracts';
import {
  processingCompletedFixture,
  processingFailedFixture,
  processingStartedFixture,
} from '@fiapx/contracts/fixtures';
import { InMemoryObjectStorage } from '@fiapx/storage/testing';
import {
  aUser,
  aVideo,
  FakeUnitOfWork,
  FixedClock,
  NOW,
  RecordingVideoMetrics,
  USER_ID,
  VIDEO_ID,
} from '../../../../../test/support/fakes';
import { videoCompletedEvent, videoFailedEvent } from '@fiapx/contracts';
import { RawVideoCleanup } from '../raw-video.cleanup';
import {
  ApplyProcessingEventUseCase,
  PROCESSING_CONSUMER,
} from './apply-processing-event.use-case';

const RAW_KEY = `${USER_ID}/${VIDEO_ID}.mp4`;

async function setup(video = aVideo()) {
  const uow = new FakeUnitOfWork();
  uow.users.users.set(USER_ID, aUser());
  uow.videos.add(video);
  const storage = new InMemoryObjectStorage();
  await storage.putStream({ bucket: 'fiapx-raw', key: RAW_KEY, body: Buffer.from('raw') });
  const metrics = new RecordingVideoMetrics();
  const useCase = new ApplyProcessingEventUseCase(
    uow,
    metrics,
    new FixedClock(),
    new RawVideoCleanup(storage, { raw: 'fiapx-raw', zips: 'fiapx-zips' }),
  );
  return { uow, storage, metrics, useCase };
}

const withId = <T extends ProcessingEvent>(event: T, id: string): T => ({ ...event, id });

describe('ApplyProcessingEventUseCase', () => {
  it('started: QUEUED → PROCESSING + history, no outbox event, raw kept', async () => {
    const { uow, storage, useCase } = await setup();

    const outcome = await useCase.execute(processingStartedFixture, processingStartedFixture.id);

    expect(outcome).toMatchObject({
      result: 'applied',
      transition: { from: 'QUEUED', to: 'PROCESSING' },
    });
    expect(uow.videos.snapshot(VIDEO_ID)).toMatchObject({ status: 'PROCESSING', attempts: 1 });
    expect(uow.videos.history).toHaveLength(1);
    expect(uow.outbox.events).toHaveLength(0);
    expect(storage.contentOf('fiapx-raw', RAW_KEY)).toBeDefined();
    expect(
      uow.processedMessages.seen.has(`${PROCESSING_CONSUMER}:${processingStartedFixture.id}`),
    ).toBe(true);
  });

  it('completed: COMPLETED + outbox video.completed (with e-mail/name for the notification) + raw deleted', async () => {
    const { uow, storage, metrics, useCase } = await setup(
      aVideo({ status: 'PROCESSING', attempts: 1 }),
    );

    await useCase.execute(processingCompletedFixture, processingCompletedFixture.id);

    expect(uow.videos.snapshot(VIDEO_ID)).toMatchObject({
      status: 'COMPLETED',
      zipKey: processingCompletedFixture.payload.zipKey,
      frameCount: 3,
      completedAt: NOW,
    });
    const [event] = uow.outbox.ofType('video.completed');
    expect(videoCompletedEvent.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      correlationId: processingCompletedFixture.correlationId,
      payload: {
        videoId: VIDEO_ID,
        userId: USER_ID,
        userEmail: 'ana@example.com',
        userName: 'Ana Souza',
        originalName: 'demo.mp4',
        frameCount: 3,
      },
    });
    expect(uow.outbox.events[0]?.aggregateId).toBe(VIDEO_ID);
    expect(storage.contentOf('fiapx-raw', RAW_KEY)).toBeUndefined();
    expect(metrics.completedCount).toBe(1);
  });

  it('failed: FAILED with the worker error code + outbox video.failed + raw deleted', async () => {
    const { uow, storage, metrics, useCase } = await setup(
      aVideo({ status: 'PROCESSING', attempts: 1 }),
    );

    await useCase.execute(processingFailedFixture, processingFailedFixture.id);

    expect(uow.videos.snapshot(VIDEO_ID)).toMatchObject({ status: 'FAILED', errorCode: 'P0001' });
    const [event] = uow.outbox.ofType('video.failed');
    expect(videoFailedEvent.parse(event)).toEqual(event);
    expect(event?.payload).toMatchObject({ errorCode: 'P0001', userId: USER_ID });
    expect(storage.contentOf('fiapx-raw', RAW_KEY)).toBeUndefined();
    expect(metrics.failures).toEqual(['P0001']);
  });

  it('redelivered message (same messageId) has no effect but retries the raw deletion', async () => {
    const { uow, storage, metrics, useCase } = await setup(
      aVideo({ status: 'PROCESSING', attempts: 1 }),
    );
    await useCase.execute(processingCompletedFixture, 'msg-1');
    await storage.putStream({ bucket: 'fiapx-raw', key: RAW_KEY, body: Buffer.from('raw') });

    const outcome = await useCase.execute(processingCompletedFixture, 'msg-1');

    expect(outcome.result).toBe('duplicate');
    expect(uow.outbox.events).toHaveLength(1);
    expect(uow.videos.history).toHaveLength(1);
    expect(metrics.completedCount).toBe(1);
    expect(storage.contentOf('fiapx-raw', RAW_KEY)).toBeUndefined();
  });

  it('invalid transition (started after COMPLETED) is ignored and acked', async () => {
    const { uow, useCase } = await setup(aVideo({ status: 'COMPLETED', zipKey: 'z' }));

    const outcome = await useCase.execute(withId(processingStartedFixture, 'late'), 'late');

    expect(outcome.result).toBe('ignored');
    expect(uow.videos.snapshot(VIDEO_ID)?.status).toBe('COMPLETED');
    expect(uow.videos.history).toHaveLength(0);
  });

  it('unknown video (e.g. account deleted) is acked without effect', async () => {
    const { uow, useCase } = await setup();
    uow.videos.videos.clear();
    await expect(useCase.execute(processingStartedFixture, 'm')).resolves.toEqual({
      result: 'unknown-video',
    });
  });

  it('retry attempt: PROCESSING → PROCESSING recorded in the history', async () => {
    const { uow, useCase } = await setup(aVideo({ status: 'PROCESSING', attempts: 1 }));
    const retry = {
      ...processingStartedFixture,
      id: 'retry',
      payload: { ...processingStartedFixture.payload, attempt: 2 },
    };

    await useCase.execute(retry, 'retry');

    expect(uow.videos.history[0]).toMatchObject({
      fromStatus: 'PROCESSING',
      toStatus: 'PROCESSING',
    });
    expect(uow.videos.snapshot(VIDEO_ID)?.attempts).toBe(2);
  });

  it('database failure rolls everything back (the message is retried by the runner)', async () => {
    const { uow, useCase } = await setup(aVideo({ status: 'PROCESSING', attempts: 1 }));
    jest.spyOn(uow.outbox, 'add').mockRejectedValueOnce(new Error('db down'));

    await expect(useCase.execute(processingCompletedFixture, 'm')).rejects.toThrow('db down');
    expect(uow.videos.snapshot(VIDEO_ID)?.status).toBe('PROCESSING');
    expect(uow.processedMessages.seen.size).toBe(0);
  });

  it('raw deletion failure → RetryableError (committed state stays)', async () => {
    const { uow, storage, useCase } = await setup(aVideo({ status: 'PROCESSING', attempts: 1 }));
    storage.failNext('delete');

    await expect(useCase.execute(processingCompletedFixture, 'm')).rejects.toBeInstanceOf(
      RetryableError,
    );
    expect(uow.videos.snapshot(VIDEO_ID)?.status).toBe('COMPLETED');
  });

  it('owner missing (should not happen, FK) → transition without the notification event', async () => {
    const { uow, useCase } = await setup(aVideo({ status: 'PROCESSING', attempts: 1 }));
    uow.users.users.clear();
    await useCase.execute(processingFailedFixture, 'm');
    expect(uow.videos.snapshot(VIDEO_ID)?.status).toBe('FAILED');
    expect(uow.outbox.events).toHaveLength(0);
  });
});
