import { createStandaloneApp, exitOnBootstrapError } from '@fiapx/observability';
import { Logger } from 'nestjs-pino';
import type { WorkerConfig } from './config/worker.config';
import { WORKER_CONFIG, SERVICE_NAME } from './config/worker.config';
import { WorkerModule } from './worker.module';

/**
 * Standalone Nest context: no public routes. SIGTERM/SIGINT trigger the graceful shutdown
 * (stop consuming, finish the video in progress, then close AMQP/S3).
 */
async function bootstrap(): Promise<void> {
  const app = await createStandaloneApp(WorkerModule);
  const config = app.get<WorkerConfig>(WORKER_CONFIG);
  app
    .get(Logger)
    .log(
      `${SERVICE_NAME} started (version ${config.APP_VERSION}, prefetch ${config.WORKER_PREFETCH})`,
      'Bootstrap',
    );
}

bootstrap().catch(exitOnBootstrapError(SERVICE_NAME));
