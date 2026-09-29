import { videoFailedEvent } from '@fiapx/contracts';
import { videoUploadedFixture } from '@fiapx/contracts/fixtures';
import { InMemoryObjectStorage } from '@fiapx/storage/testing';
import {
  aUser,
  aVideo,
  FakeUnitOfWork,
  FixedClock,
  RecordingVideoMetrics,
  USER_ID,
  VIDEO_ID,
} from '../../../../../test/support/fakes';
import { RawVideoCleanup } from '../raw-video.cleanup';
import { HandleDeadLetterUseCase } from './handle-dead-letter.use-case';

const RAW_KEY = `${USER_ID}/${VIDEO_ID}.mp4`;

async function setup(video = aVideo({ status: 'PROCESSING', attempts: 4 })) {
  const uow = new FakeUnitOfWork();
  uow.users.users.set(USER_ID, aUser());
  uow.videos.add(video);
  const storage = new InMemoryObjectStorage();
  await storage.putStream({ bucket: 'fiapx-raw', key: RAW_KEY, body: Buffer.from('raw') });
  const metrics = new RecordingVideoMetrics();
  const useCase = new HandleDeadLetterUseCase(
    uow,
    metrics,
    new FixedClock(),
    new RawVideoCleanup(storage, { raw: 'fiapx-raw', zips: 'fiapx-zips' }),
  );
  return { uow, storage, metrics, useCase };
}

describe('HandleDeadLetterUseCase', () => {
  it('crash loop (delivery_limit): PROCESSING → FAILED P0099 + outbox video.failed + raw deleted', async () => {
    const { uow, storage, metrics, useCase } = await setup();

    await expect(
      useCase.execute(videoUploadedFixture, videoUploadedFixture.id, 'delivery_limit'),
    ).resolves.toBe('failed');

    expect(uow.videos.snapshot(VIDEO_ID)).toMatchObject({
      status: 'FAILED',
      errorCode: 'P0099',
      attempts: 4,
    });
    expect(uow.videos.history[0]).toMatchObject({
      toStatus: 'FAILED',
      reason: 'Processamento abortado após dead-letter (P0099)',
    });
    const [event] = uow.outbox.ofType('video.failed');
    expect(videoFailedEvent.parse(event)).toEqual(event);
    expect(event?.payload).toMatchObject({ errorCode: 'P0099', userEmail: 'ana@example.com' });
    expect(storage.contentOf('fiapx-raw', RAW_KEY)).toBeUndefined();
    expect(metrics.failures).toEqual(['P0099']);
  });

  it('retries exhausted in the worker (rejected) → FAILED P0098, still counted by the SLO', async () => {
    const { uow, metrics, useCase } = await setup();

    await useCase.execute(videoUploadedFixture, videoUploadedFixture.id, 'rejected');

    expect(uow.videos.snapshot(VIDEO_ID)).toMatchObject({
      status: 'FAILED',
      errorCode: 'P0098',
      errorMessage: 'O processamento falhou após todas as tentativas.',
    });
    expect(uow.videos.history[0]?.reason).toBe('Tentativas esgotadas no worker (P0098)');
    expect(uow.outbox.ofType('video.failed')[0]?.payload.errorCode).toBe('P0098');
    expect(metrics.failures).toEqual(['P0098']);
  });

  it('unknown death reason → P0099; a video that never started keeps startedAt empty', async () => {
    const { uow, useCase } = await setup(aVideo({ status: 'QUEUED' }));

    await useCase.execute(videoUploadedFixture, videoUploadedFixture.id);

    expect(uow.videos.snapshot(VIDEO_ID)).toMatchObject({ errorCode: 'P0099', startedAt: null });
  });

  it('already terminal (COMPLETED) is left as is', async () => {
    const { uow, useCase } = await setup(aVideo({ status: 'COMPLETED', zipKey: 'z' }));
    await expect(useCase.execute(videoUploadedFixture, 'm')).resolves.toBe('already-terminal');
    expect(uow.videos.snapshot(VIDEO_ID)?.status).toBe('COMPLETED');
    expect(uow.outbox.events).toHaveLength(0);
  });

  it('duplicate dead-letter copy → no second event', async () => {
    const { uow, useCase } = await setup();
    await useCase.execute(videoUploadedFixture, 'm');
    await expect(useCase.execute(videoUploadedFixture, 'm')).resolves.toBe('duplicate');
    expect(uow.outbox.events).toHaveLength(1);
  });

  it('unknown video → acked without effect', async () => {
    const { uow, useCase } = await setup();
    uow.videos.videos.clear();
    await expect(useCase.execute(videoUploadedFixture, 'm')).resolves.toBe('unknown-video');
  });
});
