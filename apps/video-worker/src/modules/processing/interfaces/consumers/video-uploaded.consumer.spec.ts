import { ProcessingErrors, RetryableError } from '@fiapx/common';
import { videoUploadedFixture } from '@fiapx/contracts/fixtures';
import type { AmqpConnection, MessageConsumers } from '@fiapx/messaging';
import { ConsumerRunner, MessagingMetrics } from '@fiapx/messaging';
import {
  consumeMessageFor,
  messageContext,
  RecordingAckChannel,
  RecordingEventPublisher,
} from '@fiapx/messaging/testing';
import { Registry } from '@prometheus-io/client';
import type { WorkerConfig } from '../../../../config/worker.config';
import type { ProcessVideoUseCase } from '../../application/use-cases/process-video.use-case';
import { ReportProcessingFailureUseCase } from '../../application/use-cases/report-processing-failure.use-case';
import { VideoUploadedConsumer } from './video-uploaded.consumer';

const silent = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

function setup(execute: ProcessVideoUseCase['execute']) {
  const consumers = { start: jest.fn() };
  const processVideo = { execute: jest.fn(execute) };
  const publisher = new RecordingEventPublisher();
  const consumer = new VideoUploadedConsumer(
    consumers as unknown as MessageConsumers,
    processVideo as unknown as ProcessVideoUseCase,
    new ReportProcessingFailureUseCase(publisher),
    { WORKER_PREFETCH: 2 } as WorkerConfig,
  );
  // The runner only needs the connection to start consuming; handleDelivery never touches it.
  const runner = new ConsumerRunner(consumer.definition(), {
    connection: {} as AmqpConnection,
    publisher,
    metrics: new MessagingMetrics(new Registry()),
    logger: silent,
  });
  return {
    consumers,
    processVideo,
    publisher,
    consumer,
    runner,
    channel: new RecordingAckChannel(),
  };
}

const completed = () =>
  Promise.resolve({ status: 'completed' as const, frameCount: 3, zipSizeBytes: 10, durationMs: 5 });

describe('VideoUploadedConsumer', () => {
  it('registers worker.video-uploaded with the configured prefetch on bootstrap', () => {
    const { consumers, consumer } = setup(completed);

    consumer.onApplicationBootstrap();

    expect(consumers.start).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'worker.video-uploaded', prefetch: 2 }),
    );
  });

  it('hands the payload, message id, correlation id and retry count to the use case', async () => {
    const { consumer, processVideo } = setup(completed);

    await consumer
      .definition()
      .handle(videoUploadedFixture, messageContext(videoUploadedFixture, { retryCount: 2 }));

    expect(processVideo.execute).toHaveBeenCalledWith({
      messageId: videoUploadedFixture.id,
      correlationId: videoUploadedFixture.correlationId,
      retryCount: 2,
      video: videoUploadedFixture.payload,
    });
  });

  it('success → ack', async () => {
    const { runner, channel } = setup(completed);

    await expect(
      runner.handleDelivery(channel, consumeMessageFor(videoUploadedFixture)),
    ).resolves.toBe('success');
    expect(channel.acks).toHaveLength(1);
  });

  it('permanent error → video.processing.failed published, then ack (no retry)', async () => {
    const { runner, channel, publisher } = setup(() =>
      Promise.reject(ProcessingErrors.INVALID_VIDEO('exit code 183')),
    );

    await expect(
      runner.handleDelivery(
        channel,
        consumeMessageFor(videoUploadedFixture, { headers: { 'x-retry-count': 1 } }),
      ),
    ).resolves.toBe('permanent_failure');

    expect(channel.acks).toHaveLength(1);
    expect(publisher.rawMessages).toEqual([]);
    expect(publisher.ofType('video.processing.failed')[0]).toMatchObject({
      correlationId: videoUploadedFixture.correlationId,
      payload: { videoId: videoUploadedFixture.payload.videoId, attempt: 2, errorCode: 'P0001' },
    });
  });

  it('transient error → copy to worker.video-uploaded.retry.1, then ack', async () => {
    const { runner, channel, publisher } = setup(() =>
      Promise.reject(new RetryableError('FFMPEG_TIMEOUT')),
    );

    await expect(
      runner.handleDelivery(channel, consumeMessageFor(videoUploadedFixture)),
    ).resolves.toBe('retry');

    expect(publisher.rawMessages[0]).toMatchObject({
      exchange: '',
      routingKey: 'worker.video-uploaded.retry.1',
      messageId: videoUploadedFixture.id,
    });
    expect(publisher.events).toEqual([]);
    expect(channel.acks).toHaveLength(1);
  });

  it('transient error after 3 retries → DLX (the video-api marks P0099)', async () => {
    const { runner, channel } = setup(() => Promise.reject(new RetryableError('x')));

    await expect(
      runner.handleDelivery(
        channel,
        consumeMessageFor(videoUploadedFixture, { headers: { 'x-retry-count': 3 } }),
      ),
    ).resolves.toBe('dead_letter');
    expect(channel.deadLettered).toHaveLength(1);
  });
});
