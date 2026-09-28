import { TypedConfigModule } from '@fiapx/common';
import { createPinoConfig, MetricsServerModule } from '@fiapx/observability';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { WorkerConfig } from './config/worker.config';
import { WORKER_CONFIG, workerConfigSchema, SERVICE_NAME } from './config/worker.config';

/**
 * video-worker (E0: esqueleto). Sem HTTP público: só o servidor interno de /health e /metrics.
 * A partir da E4 entram o consumidor de `worker.video-uploaded`, ffprobe/ffmpeg e o zip em stream.
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
  ],
})
export class WorkerModule {}
