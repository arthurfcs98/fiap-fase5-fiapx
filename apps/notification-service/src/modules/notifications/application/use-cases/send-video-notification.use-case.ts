import { randomUUID } from 'node:crypto';
import { RetryableError } from '@fiapx/common';
import type { PayloadOf } from '@fiapx/contracts';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EmailRejectedError } from '../../domain/email-rejected.error';
import type { Notification, NotificationType } from '../../domain/notification';
import { isAnonymized, notificationDedupKey } from '../../domain/notification';
import { describeFailure, safeErrorText } from '../../domain/personal-data';
import type { EmailSender } from '../../domain/ports/email-sender.port';
import { EMAIL_SENDER } from '../../domain/ports/email-sender.port';
import type { INotificationMetrics } from '../../domain/ports/notification-metrics.port';
import { NOTIFICATION_METRICS } from '../../domain/ports/notification-metrics.port';
import type {
  DeliveryStep,
  INotificationRepository,
} from '../../domain/ports/notification.repository';
import { NOTIFICATION_REPOSITORY } from '../../domain/ports/notification.repository';
import type { NotificationSettings } from '../notification.settings';
import { NOTIFICATION_SETTINGS } from '../notification.settings';
import type { RenderedEmail } from '../templates/video-email.templates';
import {
  renderVideoCompletedEmail,
  renderVideoFailedEmail,
} from '../templates/video-email.templates';

interface CommandBase {
  correlationId: string;
  /**
   * Last delivery the queue will make (retries exhausted after this one): a transient failure
   * now marks the notification FAILED before the message goes to the DLQ.
   */
  finalAttempt: boolean;
}

export type VideoNotificationCommand =
  | (CommandBase & { type: 'VIDEO_FAILED'; payload: PayloadOf<'video.failed'> })
  | (CommandBase & { type: 'VIDEO_COMPLETED'; payload: PayloadOf<'video.completed'> });

/** How the event ended (a transient failure throws `RetryableError` instead). */
export type VideoNotificationResult =
  'SENT' | 'DISABLED' | 'DUPLICATE' | 'RECIPIENT_REMOVED' | 'REJECTED';

type Delivery =
  | { kind: 'sent'; notificationId: string; providerMessageId: string }
  | { kind: 'duplicate'; notificationId: string }
  | { kind: 'recipient-removed'; notificationId: string }
  | { kind: 'rejected'; notificationId: string; reason: string }
  | { kind: 'transient'; notificationId: string; reason: string; final: boolean };

/** Stored in `last_error` when the user was deleted before the e-mail went out. */
export const RECIPIENT_REMOVED_ERROR = 'Recipient removed (LGPD anonymization): e-mail not sent';

/**
 * `video.failed` (always) and `video.completed` (only with `NOTIFY_ON_SUCCESS=true`) → e-mail.
 *
 * 1. Idempotent registration by `dedup_key` (`INSERT ... ON CONFLICT DO NOTHING`).
 * 2. Under the row lock: SENT → nothing to do (duplicate event); anonymized → FAILED, no e-mail;
 *    otherwise send with the notification id as idempotency key.
 * 3. SENT/FAILED/PENDING persisted before the lock is released; then the message is acked,
 *    or, on a transient failure, `RetryableError` sends it to the next `.retry.N` queue.
 *
 * Fixes the Fase 4 bug (provider error logged and swallowed, e-mail lost): no failure is ever
 * acknowledged silently. Logs carry ids only, never the address or the user's name.
 */
@Injectable()
export class SendVideoNotificationUseCase {
  private readonly logger = new Logger(SendVideoNotificationUseCase.name);

  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly repository: INotificationRepository,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(NOTIFICATION_METRICS) private readonly metrics: INotificationMetrics,
    @Inject(NOTIFICATION_SETTINGS) private readonly settings: NotificationSettings,
  ) {}

  async execute(command: VideoNotificationCommand): Promise<VideoNotificationResult> {
    const { type, payload } = command;
    const ids = { notificationType: type, videoId: payload.videoId, userId: payload.userId };

    if (type === 'VIDEO_COMPLETED' && !this.settings.notifyOnSuccess) {
      this.metrics.record(type, 'SKIPPED');
      this.logger.log({ msg: 'Success e-mails disabled (NOTIFY_ON_SUCCESS=false)', ...ids });
      return 'DISABLED';
    }

    const { email, templateData } = this.render(command);
    const dedupKey = notificationDedupKey(type, payload.videoId);
    await this.repository.registerIfAbsent({
      id: randomUUID(),
      dedupKey,
      userId: payload.userId,
      type,
      recipient: payload.userEmail,
      subject: email.subject,
      payload: templateData,
    });

    const delivery = await this.repository.deliverExclusively(dedupKey, (notification) =>
      this.attempt(notification, email, command),
    );
    return this.conclude(type, delivery, ids);
  }

  private render(command: VideoNotificationCommand): {
    email: RenderedEmail;
    templateData: Record<string, unknown>;
  } {
    const base = this.settings.publicBaseUrl;
    if (command.type === 'VIDEO_FAILED') {
      const { videoId, userName, originalName, errorCode, errorMessage } = command.payload;
      const data = { userName, originalName, errorCode, errorMessage };
      return { email: renderVideoFailedEmail(data, base), templateData: { videoId, ...data } };
    }
    const { videoId, userName, originalName, frameCount } = command.payload;
    const data = { userName, originalName, frameCount };
    return { email: renderVideoCompletedEmail(data, base), templateData: { videoId, ...data } };
  }

  private async attempt(
    notification: Notification,
    email: RenderedEmail,
    command: VideoNotificationCommand,
  ): Promise<DeliveryStep<Delivery>> {
    const notificationId = notification.id;
    if (notification.status === 'SENT') {
      return { result: { kind: 'duplicate', notificationId } };
    }
    if (isAnonymized(notification)) {
      return {
        record:
          notification.status === 'FAILED'
            ? undefined
            : { status: 'FAILED', error: RECIPIENT_REMOVED_ERROR, attempted: false },
        result: { kind: 'recipient-removed', notificationId },
      };
    }

    try {
      const receipt = await this.sender.send({
        idempotencyKey: notificationId,
        to: notification.recipient,
        subject: email.subject,
        html: email.html,
        text: email.text,
        correlationId: command.correlationId,
      });
      return {
        record: { status: 'SENT', providerMessageId: receipt.providerMessageId },
        result: { kind: 'sent', notificationId, providerMessageId: receipt.providerMessageId },
      };
    } catch (error) {
      if (error instanceof EmailRejectedError) {
        return {
          record: { status: 'FAILED', error: error.message, attempted: true },
          result: { kind: 'rejected', notificationId, reason: error.reason },
        };
      }
      const reason =
        error instanceof RetryableError ? safeErrorText(error.reason) : describeFailure(error);
      const final = command.finalAttempt;
      return {
        record: final
          ? { status: 'FAILED', error: `Retries exhausted: ${reason}`, attempted: true }
          : { status: 'PENDING', error: reason, attempted: true },
        result: { kind: 'transient', notificationId, reason, final },
      };
    }
  }

  private conclude(
    type: NotificationType,
    delivery: Delivery,
    ids: Record<string, string>,
  ): VideoNotificationResult {
    const log = { ...ids, notificationId: delivery.notificationId };
    switch (delivery.kind) {
      case 'sent':
        this.metrics.record(type, 'SENT');
        this.logger.log({
          msg: 'E-mail sent',
          ...log,
          provider: this.sender.provider,
          providerMessageId: delivery.providerMessageId,
        });
        return 'SENT';
      case 'duplicate':
        this.metrics.record(type, 'SKIPPED');
        this.logger.log({ msg: 'Notification already sent: duplicate event acknowledged', ...log });
        return 'DUPLICATE';
      case 'recipient-removed':
        this.metrics.record(type, 'SKIPPED');
        this.logger.warn({ msg: 'Recipient removed (LGPD): e-mail not sent', ...log });
        return 'RECIPIENT_REMOVED';
      case 'rejected':
        this.metrics.record(type, 'FAILED');
        this.logger.warn({
          msg: 'E-mail rejected by the provider: notification FAILED, no retry',
          ...log,
          provider: this.sender.provider,
          reason: delivery.reason,
        });
        return 'REJECTED';
      case 'transient':
        this.metrics.record(type, delivery.final ? 'FAILED' : 'RETRY');
        this.logger.warn({
          msg: delivery.final
            ? 'E-mail failed on the last attempt: notification FAILED, message goes to the DLQ'
            : 'Transient e-mail failure: the message will be retried',
          ...log,
          provider: this.sender.provider,
          reason: delivery.reason,
        });
        throw new RetryableError(delivery.reason);
    }
  }
}
