import { TypedConfigModule } from '@fiapx/common';
import { MessagingModule } from '@fiapx/messaging';
import { createPinoConfig, MetricsServerModule } from '@fiapx/observability';
import { storageOptionsFromConfig, StorageModule } from '@fiapx/storage';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { WorkerConfig } from './config/worker.config';
import {
  SERVICE_NAME,
  WORKER_CONFIG,
  WORKER_SHUTDOWN_TIMEOUT_MS,
  workerConfigSchema,
} from './config/worker.config';
import { ProcessingModule } from './modules/processing/processing.module';

/**
 * video-worker: no public HTTP, only the internal /health and /metrics server. Consumes
 * `worker.video-uploaded`, extracts frames with ffmpeg and uploads the zip (contratos.md §9).
 * Messaging and storage are global and do not block the boot while RabbitMQ/Garage are down.
 */
@Module({
  imports: [
    TypedConfigModule.forRoot({ token: WORKER_CONFIG, schema: workerConfigSchema }),
    LoggerModule.forRootAsync({
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) =>
        createPinoConfig({
          serviceName: SERVICE_NAME,
          version: config.APP_VERSION,
          level: config.LOG_LEVEL,
        }),
    }),
    MetricsServerModule.forRootAsync({
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => ({
        serviceName: SERVICE_NAME,
        version: config.APP_VERSION,
        port: config.METRICS_PORT,
        host: config.METRICS_HOST,
        token: config.METRICS_TOKEN,
      }),
    }),
    MessagingModule.forRootAsync({
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => ({
        url: config.RABBITMQ_URL,
        connectionName: SERVICE_NAME,
        shutdownTimeoutMs: WORKER_SHUTDOWN_TIMEOUT_MS,
      }),
    }),
    StorageModule.forRootAsync({
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => storageOptionsFromConfig(config),
    }),
    ProcessingModule,
  ],
})
export class WorkerModule {}
