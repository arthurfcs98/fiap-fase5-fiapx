import { METRICS_REGISTRY } from '@fiapx/observability';
import { Module } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';
import type { NotificationConfig } from '../../config/notification.config';
import { NOTIFICATION_CONFIG } from '../../config/notification.config';
import {
  NOTIFICATION_SETTINGS,
  notificationSettingsFromConfig,
} from './application/notification.settings';
import { AnonymizeUserNotificationsUseCase } from './application/use-cases/anonymize-user-notifications.use-case';
import { ApplyNotificationRetentionUseCase } from './application/use-cases/apply-notification-retention.use-case';
import { SendVideoNotificationUseCase } from './application/use-cases/send-video-notification.use-case';
import { EMAIL_SENDER } from './domain/ports/email-sender.port';
import { NOTIFICATION_METRICS } from './domain/ports/notification-metrics.port';
import { NOTIFICATION_REPOSITORY } from './domain/ports/notification.repository';
import { createEmailSender } from './infrastructure/email/email-sender.factory';
import { PrometheusNotificationMetrics } from './infrastructure/metrics/prometheus-notification-metrics';
import { TypeOrmNotificationRepository } from './infrastructure/persistence/typeorm-notification.repository';
import { NotificationEventsConsumer } from './interfaces/consumers/notification-events.consumer';
import { NotificationRetentionJob } from './interfaces/jobs/notification-retention.job';

/**
 * Notifications: consumer of `notification.events`, use cases, retention job and the adapters
 * behind the domain ports (TypeORM, Resend/SMTP/Log, Prometheus). `DataSource`,
 * `MessageConsumers` and `METRICS_REGISTRY` come from the global modules of the root module.
 */
@Module({
  providers: [
    {
      provide: NOTIFICATION_SETTINGS,
      inject: [NOTIFICATION_CONFIG],
      useFactory: (config: NotificationConfig) => notificationSettingsFromConfig(config),
    },
    {
      provide: EMAIL_SENDER,
      inject: [NOTIFICATION_CONFIG],
      useFactory: (config: NotificationConfig) => createEmailSender(config),
    },
    {
      provide: NOTIFICATION_METRICS,
      inject: [METRICS_REGISTRY],
      useFactory: (registry: Registry) => new PrometheusNotificationMetrics(registry),
    },
    { provide: NOTIFICATION_REPOSITORY, useClass: TypeOrmNotificationRepository },
    SendVideoNotificationUseCase,
    AnonymizeUserNotificationsUseCase,
    ApplyNotificationRetentionUseCase,
    NotificationEventsConsumer,
    NotificationRetentionJob,
  ],
})
export class NotificationsModule {}
