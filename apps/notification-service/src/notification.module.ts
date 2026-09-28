import { TypedConfigModule } from '@fiapx/common';
import { createPinoConfig, MetricsServerModule } from '@fiapx/observability';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { NotificationConfig } from './config/notification.config';
import {
  NOTIFICATION_CONFIG,
  notificationConfigSchema,
  SERVICE_NAME,
} from './config/notification.config';

/**
 * notification-service (E0: esqueleto). Sem HTTP público: só o servidor interno de /health e
 * /metrics. A partir da E5 entram o consumidor de `notification.events` e o envio de e-mail.
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
  ],
})
export class NotificationModule {}
