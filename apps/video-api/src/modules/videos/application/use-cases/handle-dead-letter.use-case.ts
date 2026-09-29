import { ProcessingErrors } from '@fiapx/common';
import type { VideoUploadedEvent } from '@fiapx/contracts';
import { MAX_RETRIES, QUEUES } from '@fiapx/messaging';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work';
import { UNIT_OF_WORK } from '../../../../shared/application/unit-of-work';
import type { Clock } from '../../../../shared/domain/clock';
import { CLOCK } from '../../../../shared/domain/clock';
import type { Video } from '../../domain/video';
import type { VideoMetrics } from '../ports/video.metrics';
import { VIDEO_METRICS } from '../ports/video.metrics';
import { RawVideoCleanup } from '../raw-video.cleanup';
import { recordTransition } from '../video-transition.recorder';

/** `processed_messages.consumer` of this use case. */
export const DEAD_LETTER_CONSUMER = QUEUES.apiVideoDeadLetter;

export type DeadLetterOutcome = 'failed' | 'already-terminal' | 'duplicate' | 'unknown-video';

/** Dead-letter reason of a `nack(requeue=false)` of the worker: its retries were exhausted. */
export const RETRIES_EXHAUSTED_REASON = 'rejected';

/**
 * Consumer of `api.video-deadletter` (copy of every `video.uploaded` that died in the worker).
 * The video ends in FAILED with a `video.failed` in the outbox, so the user always reaches a
 * terminal state and gets the e-mail:
 * - `P0098 RETRIES_EXHAUSTED` when the worker gave up after its retries (death reason
 *   `rejected`);
 * - `P0099 PROCESSING_ABORTED` otherwise (crash loop: `delivery_limit`, or unknown).
 * A video already COMPLETED/FAILED is left as is.
 */
@Injectable()
export class HandleDeadLetterUseCase {
  private readonly logger = new Logger(HandleDeadLetterUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(VIDEO_METRICS) private readonly metrics: VideoMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly rawCleanup: RawVideoCleanup,
  ) {}

  async execute(
    event: VideoUploadedEvent,
    messageId: string,
    deathReason?: string,
  ): Promise<DeadLetterOutcome> {
    const now = this.clock.now();
    const aborted =
      deathReason === RETRIES_EXHAUSTED_REASON
        ? ProcessingErrors.RETRIES_EXHAUSTED(MAX_RETRIES + 1).appError
        : ProcessingErrors.PROCESSING_ABORTED().appError;
    const { outcome, video } = await this.uow.run(
      async (tx): Promise<{ outcome: DeadLetterOutcome; video?: Video }> => {
        const firstDelivery = await tx.processedMessages.markProcessed(
          messageId,
          DEAD_LETTER_CONSUMER,
        );
        const locked = await tx.videos.lockById(event.payload.videoId);
        if (!locked) return { outcome: 'unknown-video' };
        if (!firstDelivery) return { outcome: 'duplicate', video: locked };

        const transition = locked.fail(
          { errorCode: aborted.code, errorMessage: aborted.description },
          now,
          undefined,
          deathReason === RETRIES_EXHAUSTED_REASON
            ? `Tentativas esgotadas no worker (${aborted.code})`
            : `Processamento abortado após dead-letter (${aborted.code})`,
        );
        if (!transition) return { outcome: 'already-terminal', video: locked };
        await recordTransition(tx, locked, transition, event.correlationId, now);
        return { outcome: 'failed', video: locked };
      },
    );

    const context = { videoId: event.payload.videoId, eventId: event.id, deathReason };
    if (outcome === 'failed') {
      this.metrics.failed(aborted.code);
      this.logger.warn({ msg: 'Vídeo marcado como FAILED pela dead-letter', ...context });
    } else {
      this.logger.log({ msg: 'Dead-letter sem efeito', outcome, ...context });
    }
    if (video?.isTerminal) await this.rawCleanup.deleteRaw(video);
    return outcome;
  }
}
