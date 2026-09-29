import { videoUploadedEvent } from '@fiapx/contracts';
import type { ConsumerDefinition } from '@fiapx/messaging';
import { MessageConsumers, QUEUES } from '@fiapx/messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { WorkerConfig } from '../../../../config/worker.config';
import { WORKER_CONFIG } from '../../../../config/worker.config';
import { ProcessVideoUseCase } from '../../application/use-cases/process-video.use-case';
import { ReportProcessingFailureUseCase } from '../../application/use-cases/report-processing-failure.use-case';

/**
 * Consumer of `worker.video-uploaded` (prefetch `WORKER_PREFETCH`). The runner validates the
 * envelope, restores the correlation id and applies the queue rules: resolved → ack;
 * `RetryableError` → `.retry.N` (then DLX); `NonRetryableError` → `video.processing.failed` + ack.
 *
 * SIGTERM: `MessageConsumers` cancels the consumer and waits for the video in progress
 * (`WORKER_SHUTDOWN_TIMEOUT_MS`) before the connection closes.
 */
@Injectable()
export class VideoUploadedConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly consumers: MessageConsumers,
    private readonly processVideo: ProcessVideoUseCase,
    private readonly reportFailure: ReportProcessingFailureUseCase,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.start(this.definition());
  }

  definition(): ConsumerDefinition<typeof videoUploadedEvent> {
    return {
      queue: QUEUES.workerVideoUploaded,
      schema: videoUploadedEvent,
      prefetch: this.config.WORKER_PREFETCH,
      handle: async (event, context) => {
        await this.processVideo.execute({
          messageId: context.messageId,
          correlationId: event.correlationId,
          retryCount: context.retryCount,
          video: event.payload,
        });
      },
      onPermanentFailure: (event, error, context) =>
        this.reportFailure.execute({
          messageId: context.messageId,
          correlationId: event.correlationId,
          retryCount: context.retryCount,
          videoId: event.payload.videoId,
          error: error.appError,
        }),
    };
  }
}
