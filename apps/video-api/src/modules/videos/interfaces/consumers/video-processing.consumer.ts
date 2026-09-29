import { processingEvent } from '@fiapx/contracts';
import type { ConsumerDefinition } from '@fiapx/messaging';
import { MessageConsumers, QUEUES } from '@fiapx/messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ApplyProcessingEventUseCase } from '../../application/use-cases/apply-processing-event.use-case';

/** Contract prefetch of the video-api consumers (contratos.md, section 2). */
export const API_CONSUMER_PREFETCH = 10;

/**
 * `api.video-processing` (binding `video.processing.*`): started/completed/failed from the
 * worker. Resolves only after the commit (ack after the durable effect); a database error is
 * transient and goes through the `.retry.N` queues.
 */
@Injectable()
export class VideoProcessingConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly consumers: MessageConsumers,
    private readonly applyProcessingEvent: ApplyProcessingEventUseCase,
  ) {}

  definition(): ConsumerDefinition<typeof processingEvent> {
    return {
      queue: QUEUES.apiVideoProcessing,
      schema: processingEvent,
      prefetch: API_CONSUMER_PREFETCH,
      handle: async (event, context) => {
        await this.applyProcessingEvent.execute(event, context.messageId);
      },
    };
  }

  onApplicationBootstrap(): void {
    this.consumers.start(this.definition());
  }
}
