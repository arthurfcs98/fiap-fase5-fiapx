import type { NotificationEvent } from '@fiapx/contracts';
import { notificationEvent } from '@fiapx/contracts';
import type { ConsumerDefinition, MessageContext } from '@fiapx/messaging';
import { decideRetry, MessageConsumers, QUEUES } from '@fiapx/messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { AnonymizeUserNotificationsUseCase } from '../../application/use-cases/anonymize-user-notifications.use-case';
import { SendVideoNotificationUseCase } from '../../application/use-cases/send-video-notification.use-case';
import { toQueueError } from './queue-errors';

/** contratos.md, section 2: `notification.events` is consumed with prefetch 5. */
export const NOTIFICATION_PREFETCH = 5;

/**
 * Consumer of `notification.events` (bindings `video.failed`, `video.completed` and
 * `user.deleted`). The runner validates the envelope, restores the correlation id and applies
 * the queue rules: resolved → ack (after the row is SENT/FAILED or anonymized); transient
 * failure → `.retry.N`, then DLQ.
 */
@Injectable()
export class NotificationEventsConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly consumers: MessageConsumers,
    private readonly sendVideoNotification: SendVideoNotificationUseCase,
    private readonly anonymizeUserNotifications: AnonymizeUserNotificationsUseCase,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.start(this.definition());
  }

  definition(): ConsumerDefinition<typeof notificationEvent> {
    return {
      queue: QUEUES.notificationEvents,
      schema: notificationEvent,
      prefetch: NOTIFICATION_PREFETCH,
      handle: (event, context) => this.handle(event, context),
    };
  }

  async handle(event: NotificationEvent, context: MessageContext): Promise<void> {
    try {
      await this.dispatch(event, context);
    } catch (error) {
      throw toQueueError(error);
    }
  }

  private async dispatch(event: NotificationEvent, context: MessageContext): Promise<void> {
    // The runner dead-letters a transient failure of this delivery: record it as FAILED first.
    const finalAttempt =
      decideRetry(QUEUES.notificationEvents, context.retryCount).action === 'dead-letter';
    const { correlationId } = event;

    switch (event.type) {
      case 'video.failed':
        await this.sendVideoNotification.execute({
          type: 'VIDEO_FAILED',
          payload: event.payload,
          correlationId,
          finalAttempt,
        });
        return;
      case 'video.completed':
        await this.sendVideoNotification.execute({
          type: 'VIDEO_COMPLETED',
          payload: event.payload,
          correlationId,
          finalAttempt,
        });
        return;
      case 'user.deleted':
        await this.anonymizeUserNotifications.execute(event.payload.userId);
        return;
    }
  }
}
