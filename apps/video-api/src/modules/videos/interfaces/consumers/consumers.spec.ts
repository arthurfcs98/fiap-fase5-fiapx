import { processingStartedFixture, videoUploadedFixture } from '@fiapx/contracts/fixtures';
import type { MessageConsumers } from '@fiapx/messaging';
import { messageContext } from '@fiapx/messaging/testing';
import type { ApplyProcessingEventUseCase } from '../../application/use-cases/apply-processing-event.use-case';
import type { HandleDeadLetterUseCase } from '../../application/use-cases/handle-dead-letter.use-case';
import { VideoDeadLetterConsumer } from './video-dead-letter.consumer';
import { API_CONSUMER_PREFETCH, VideoProcessingConsumer } from './video-processing.consumer';

describe('video-api consumers', () => {
  it('api.video-processing: prefetch 10, hands the event and messageId to the use case', async () => {
    const consumers = { start: jest.fn() };
    const useCase = { execute: jest.fn().mockResolvedValue({ result: 'applied' }) };
    const consumer = new VideoProcessingConsumer(
      consumers as unknown as MessageConsumers,
      useCase as unknown as ApplyProcessingEventUseCase,
    );

    consumer.onApplicationBootstrap();
    expect(consumers.start).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'api.video-processing', prefetch: API_CONSUMER_PREFETCH }),
    );
    expect(API_CONSUMER_PREFETCH).toBe(10);

    await consumer
      .definition()
      .handle(
        processingStartedFixture,
        messageContext(processingStartedFixture, { messageId: 'm-1' }),
      );
    expect(useCase.execute).toHaveBeenCalledWith(processingStartedFixture, 'm-1');
  });

  it('api.video-deadletter: passes the death reason for diagnostics', async () => {
    const consumers = { start: jest.fn() };
    const useCase = { execute: jest.fn().mockResolvedValue('failed') };
    const consumer = new VideoDeadLetterConsumer(
      consumers as unknown as MessageConsumers,
      useCase as unknown as HandleDeadLetterUseCase,
    );

    consumer.onApplicationBootstrap();
    expect(consumers.start).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'api.video-deadletter', prefetch: 10 }),
    );

    await consumer
      .definition()
      .handle(
        videoUploadedFixture,
        messageContext(videoUploadedFixture, { messageId: 'm-2', deathReason: 'delivery_limit' }),
      );
    expect(useCase.execute).toHaveBeenCalledWith(videoUploadedFixture, 'm-2', 'delivery_limit');
  });
});
