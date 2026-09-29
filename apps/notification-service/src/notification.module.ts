import { createTypeOrmOptions, TypedConfigModule } from '@fiapx/common';
import { MessagingModule } from '@fiapx/messaging';
import { createPinoConfig, MetricsServerModule } from '@fiapx/observability';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import type { NotificationConfig } from './config/notification.config';
import {
  NOTIFICATION_CONFIG,
  notificationConfigSchema,
  SERVICE_NAME,
} from './config/notification.config';
import { notificationDataSourceInput } from './database/notification-data-source';
import { NotificationsModule } from './modules/notifications/notifications.module';

/**
 * notification-service: no public HTTP, only the internal /health and /metrics server.
 * Consumes `notification.events` (e-mail on `video.failed`/`video.completed`, anonymization on
 * `user.deleted`) and runs the daily LGPD retention job. The schema comes only from the
 * `migrate` one-shot (`synchronize: false`). Messaging does not block the boot while RabbitMQ
 * is down; the database does (TypeORM retries, then the process exits and is restarted).
 */
@Module({
  imports: [
    TypedConfigModule.forRoot({ token: NOTIFICATION_CONFIG, schema: notificationConfigSchema }),
    LoggerModule.forRootAsync({
      inject: [NOTIFICATION_CONFIG],
      useFactory: (config: NotificationConfig) =>
        createPinoConfig({
          serviceName: SERVICE_NAME,
          version: config.APP_VERSION,
          level: config.LOG_LEVEL,
        }),
    }),
    MetricsServerModule.forRootAsync({
      inject: [NOTIFICATION_CONFIG],
      useFactory: (config: NotificationConfig) => ({
        serviceName: SERVICE_NAME,
        version: config.APP_VERSION,
        port: config.METRICS_PORT,
        host: config.METRICS_HOST,
        token: config.METRICS_TOKEN,
      }),
    }),
    MessagingModule.forRootAsync({
      inject: [NOTIFICATION_CONFIG],
      useFactory: (config: NotificationConfig) => ({
        url: config.RABBITMQ_URL,
        connectionName: SERVICE_NAME,
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [NOTIFICATION_CONFIG],
      useFactory: (config: NotificationConfig) =>
        createTypeOrmOptions(config, notificationDataSourceInput()),
    }),
    ScheduleModule.forRoot(),
    NotificationsModule,
  ],
})
export class NotificationModule {}
