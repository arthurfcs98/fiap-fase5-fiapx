import { createStandaloneApp, exitOnBootstrapError } from '@fiapx/observability';
import { Logger } from 'nestjs-pino';
import type { WorkerConfig } from './config/worker.config';
import { WORKER_CONFIG, SERVICE_NAME } from './config/worker.config';
import { WorkerModule } from './worker.module';

/** Contexto Nest standalone: sem rotas públicas; SIGTERM/SIGINT disparam o graceful shutdown. */
async function bootstrap(): Promise<void> {
  const app = await createStandaloneApp(WorkerModule);
  const config = app.get<WorkerConfig>(WORKER_CONFIG);
  app.get(Logger).log(`${SERVICE_NAME} iniciado (versão ${config.APP_VERSION})`, 'Bootstrap');
}

bootstrap().catch(exitOnBootstrapError(SERVICE_NAME));
