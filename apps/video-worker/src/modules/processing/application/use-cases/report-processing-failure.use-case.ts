import type { AppError } from '@fiapx/common';
import { createEvent } from '@fiapx/contracts';
import type { EventPublisher } from '@fiapx/messaging';
import { EVENT_PUBLISHER } from '@fiapx/messaging';
import { Inject, Injectable } from '@nestjs/common';
import { workerEventId } from '../event-ids';

export interface ReportProcessingFailureCommand {
  /** AMQP `messageId` of the `video.uploaded` delivery. */
  messageId: string;
  correlationId: string;
  /** `x-retry-count` of the failed attempt. */
  retryCount: number;
  videoId: string;
  /** Permanent processing error (P0001...P0005). */
  error: AppError;
}

/** `errorMessage` limit of `video.processing.failed`. */
const ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * Publishes `video.processing.failed` (publisher confirm) for a permanent error: the business
 * outcome of the message, after which the runner acks it. If publishing fails, the runner sends
 * the message through the retry path, and the retry fails the same way and publishes again.
 */
@Injectable()
export class ReportProcessingFailureUseCase {
  constructor(@Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher) {}

  async execute(command: ReportProcessingFailureCommand): Promise<void> {
    const attempt = command.retryCount + 1;
    await this.publisher.publishEvent(
      createEvent(
        'video.processing.failed',
        {
          videoId: command.videoId,
          attempt,
          errorCode: command.error.code,
          // User-facing text (pt-BR catalog description); diagnostics stay in the logs.
          errorMessage: command.error.description.slice(0, ERROR_MESSAGE_MAX_LENGTH),
        },
        command.correlationId,
        { id: workerEventId(command.messageId, 'video.processing.failed', attempt) },
      ),
    );
  }
}
