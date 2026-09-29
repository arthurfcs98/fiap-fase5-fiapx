import { AppError, ProcessingErrors } from '@fiapx/common';
import { videoUploadedFixture } from '@fiapx/contracts/fixtures';
import { PublishError } from '@fiapx/messaging';
import { RecordingEventPublisher } from '@fiapx/messaging/testing';
import { workerEventId } from '../event-ids';
import { ReportProcessingFailureUseCase } from './report-processing-failure.use-case';

const VIDEO_ID = videoUploadedFixture.payload.videoId;

describe('ReportProcessingFailureUseCase', () => {
  it('publishes video.processing.failed with the catalog code and description', async () => {
    const publisher = new RecordingEventPublisher();

    await new ReportProcessingFailureUseCase(publisher).execute({
      messageId: videoUploadedFixture.id,
      correlationId: videoUploadedFixture.correlationId,
      retryCount: 1,
      videoId: VIDEO_ID,
      error: ProcessingErrors.INVALID_VIDEO('exit code 183').appError,
    });

    expect(publisher.ofType('video.processing.failed')).toEqual([
      {
        id: workerEventId(videoUploadedFixture.id, 'video.processing.failed', 2),
        type: 'video.processing.failed',
        version: 1,
        occurredAt: expect.any(String),
        correlationId: videoUploadedFixture.correlationId,
        payload: {
          videoId: VIDEO_ID,
          attempt: 2,
          errorCode: 'P0001',
          errorMessage: 'O arquivo não é um vídeo válido ou está corrompido.',
        },
      },
    ]);
  });

  it('publishes nothing for an abandoned delivery (the redelivered copy reports it)', async () => {
    const publisher = new RecordingEventPublisher();
    const controller = new AbortController();
    controller.abort();

    await expect(
      new ReportProcessingFailureUseCase(publisher).execute({
        messageId: videoUploadedFixture.id,
        correlationId: 'cid',
        retryCount: 0,
        videoId: VIDEO_ID,
        error: ProcessingErrors.NO_FRAMES().appError,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
    expect(publisher.events).toEqual([]);
  });

  it('truncates the message to the contract limit (500)', async () => {
    const publisher = new RecordingEventPublisher();
    const long = new AppError(422, 'X', 'P0001', 'x'.repeat(800));

    await new ReportProcessingFailureUseCase(publisher).execute({
      messageId: videoUploadedFixture.id,
      correlationId: 'cid',
      retryCount: 0,
      videoId: VIDEO_ID,
      error: long,
    });

    expect(publisher.ofType('video.processing.failed')[0]?.payload.errorMessage).toHaveLength(500);
  });

  it('propagates publish failures (the runner then takes the retry path)', async () => {
    const publisher = new RecordingEventPublisher().failNextWith(
      new PublishError('fiapx.events', 'video.processing.failed'),
    );

    await expect(
      new ReportProcessingFailureUseCase(publisher).execute({
        messageId: videoUploadedFixture.id,
        correlationId: 'cid',
        retryCount: 0,
        videoId: VIDEO_ID,
        error: ProcessingErrors.NO_FRAMES().appError,
      }),
    ).rejects.toBeInstanceOf(PublishError);
  });
});
