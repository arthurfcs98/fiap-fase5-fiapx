import { createStandaloneApp, exitOnBootstrapError } from '@fiapx/observability';
import { Logger } from 'nestjs-pino';
import type { NotificationConfig } from './config/notification.config';
import { NOTIFICATION_CONFIG, SERVICE_NAME } from './config/notification.config';
import { NotificationModule } from './notification.module';

/** Contexto Nest standalone: sem rotas públicas; SIGTERM/SIGINT disparam o graceful shutdown. */
async function bootstrap(): Promise<void> {
  const app = await createStandaloneApp(NotificationModule);
  const config = app.get<NotificationConfig>(NOTIFICATION_CONFIG);
  app.get(Logger).log(`${SERVICE_NAME} iniciado (versão ${config.APP_VERSION})`, 'Bootstrap');
}

bootstrap().catch(exitOnBootstrapError(SERVICE_NAME));
