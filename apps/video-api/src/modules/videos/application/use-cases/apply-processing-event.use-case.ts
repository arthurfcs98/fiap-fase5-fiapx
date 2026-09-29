import type { ProcessingEvent } from '@fiapx/contracts';
import { QUEUES } from '@fiapx/messaging';
import { zipKey } from '@fiapx/storage';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work';
import { UNIT_OF_WORK } from '../../../../shared/application/unit-of-work';
import type { Clock } from '../../../../shared/domain/clock';
import { CLOCK } from '../../../../shared/domain/clock';
import type { StatusTransition, Video } from '../../domain/video';
import type { VideoMetrics } from '../ports/video.metrics';
import { VIDEO_METRICS } from '../ports/video.metrics';
import { RawVideoCleanup } from '../raw-video.cleanup';
import { recordTransition } from '../video-transition.recorder';

/** `processed_messages.consumer` of this use case. */
export const PROCESSING_CONSUMER = QUEUES.apiVideoProcessing;

export type ProcessingOutcome =
  | { result: 'applied'; video: Video; transition: StatusTransition }
  | { result: 'ignored'; video: Video }
  | { result: 'duplicate'; video: Video }
  | { result: 'rejected'; video: Video }
  | { result: 'unknown-video' };

/**
 * Consumer of `api.video-processing` (`video.processing.started|completed|failed`): applies the
 * state machine (contratos.md, section 3). In ONE transaction: inbox row (`processed_messages`)
 * + video + history + outbox (`video.completed`/`video.failed` for the notification-service).
 * A redelivered message hits the inbox and changes nothing; an invalid transition (late event)
 * is ignored with a log. A `completed` whose `zipKey` is not the deterministic key of THIS
 * video (`{userId}/{videoId}.zip`) is rejected: a compromised worker must not point a video at
 * another user's frames. After the commit, a terminal video loses its raw object (LGPD).
 */
@Injectable()
export class ApplyProcessingEventUseCase {
  private readonly logger = new Logger(ApplyProcessingEventUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(VIDEO_METRICS) private readonly metrics: VideoMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly rawCleanup: RawVideoCleanup,
  ) {}

  async execute(event: ProcessingEvent, messageId: string): Promise<ProcessingOutcome> {
    const now = this.clock.now();
    const outcome = await this.uow.run(async (tx): Promise<ProcessingOutcome> => {
      const firstDelivery = await tx.processedMessages.markProcessed(
        messageId,
        PROCESSING_CONSUMER,
      );
      const video = await tx.videos.lockById(event.payload.videoId);
      if (!video) return { result: 'unknown-video' };
      if (!firstDelivery) return { result: 'duplicate', video };
      if (
        event.type === 'video.processing.completed' &&
        event.payload.zipKey !== zipKey(video.userId, video.id)
      ) {
        return { result: 'rejected', video };
      }

      const transition = applyEvent(video, event, now);
      if (!transition) return { result: 'ignored', video };
      await recordTransition(tx, video, transition, event.correlationId, now);
      return { result: 'applied', video, transition };
    });

    this.report(event, outcome);
    if (outcome.result !== 'unknown-video' && outcome.video.isTerminal) {
      await this.rawCleanup.deleteRaw(outcome.video);
    }
    return outcome;
  }

  private report(event: ProcessingEvent, outcome: ProcessingOutcome): void {
    const context = { videoId: event.payload.videoId, eventType: event.type, eventId: event.id };
    switch (outcome.result) {
      case 'applied':
        if (outcome.transition.to === 'COMPLETED') {
          const { createdAt, completedAt } = outcome.video.toSnapshot();
          const finishedAt = completedAt ?? createdAt;
          this.metrics.completed((finishedAt.getTime() - createdAt.getTime()) / 1000);
        }
        if (outcome.transition.to === 'FAILED')
          this.metrics.failed(outcome.video.errorCode ?? 'P0099');
        this.logger.log({
          msg: 'Transição aplicada',
          ...context,
          from: outcome.transition.from,
          to: outcome.transition.to,
        });
        return;
      case 'ignored':
        this.logger.warn({
          msg: 'Transição inválida ignorada (evento atrasado ou repetido)',
          ...context,
          status: outcome.video.status,
        });
        return;
      case 'duplicate':
        this.logger.log({ msg: 'Mensagem já processada (idempotência)', ...context });
        return;
      case 'rejected':
        this.logger.error({
          msg: 'Evento completed com zipKey que não é a chave deste vídeo: ignorado',
          ...context,
          status: outcome.video.status,
        });
        return;
      case 'unknown-video':
        this.logger.warn({ msg: 'Evento de vídeo inexistente ignorado', ...context });
        return;
    }
  }
}

function applyEvent(video: Video, event: ProcessingEvent, at: Date): StatusTransition | null {
  switch (event.type) {
    case 'video.processing.started':
      return video.start(event.payload.attempt, at);
    case 'video.processing.completed':
      return video.complete(
        {
          zipKey: event.payload.zipKey,
          frameCount: event.payload.frameCount,
          zipSizeBytes: event.payload.zipSizeBytes,
        },
        at,
      );
    case 'video.processing.failed':
      return video.fail(
        { errorCode: event.payload.errorCode, errorMessage: event.payload.errorMessage },
        at,
        event.payload.attempt,
      );
  }
}
