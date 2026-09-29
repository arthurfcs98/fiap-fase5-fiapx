import { videoUploadedEvent } from '@fiapx/contracts';
import type { ConsumerDefinition } from '@fiapx/messaging';
import { MessageConsumers, QUEUES } from '@fiapx/messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { HandleDeadLetterUseCase } from '../../application/use-cases/handle-dead-letter.use-case';
import { API_CONSUMER_PREFETCH } from './video-processing.consumer';

/**
 * `api.video-deadletter` (`fiapx.dlx` / `worker.video-uploaded`): every `video.uploaded` that died
 * in the worker (retries exhausted or delivery limit) turns the video into FAILED `P0099`.
 */
@Injectable()
export class VideoDeadLetterConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly consumers: MessageConsumers,
    private readonly handleDeadLetter: HandleDeadLetterUseCase,
  ) {}

  definition(): ConsumerDefinition<typeof videoUploadedEvent> {
    return {
      queue: QUEUES.apiVideoDeadLetter,
      schema: videoUploadedEvent,
      prefetch: API_CONSUMER_PREFETCH,
      handle: async (event, context) => {
        await this.handleDeadLetter.execute(event, context.messageId, context.deathReason);
      },
    };
  }

  onApplicationBootstrap(): void {
    this.consumers.start(this.definition());
  }
}
