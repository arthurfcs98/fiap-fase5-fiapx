import { exitOnBootstrapError } from '@fiapx/observability';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import type { ApiConfig } from './config/api.config';
import { API_CONFIG, SERVICE_NAME } from './config/api.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get<ApiConfig>(API_CONFIG);
  configureApp(app, config);

  await app.listen(config.PORT, '0.0.0.0');
  logger.log(
    `${SERVICE_NAME} ouvindo na porta ${config.PORT} (versão ${config.APP_VERSION})`,
    'Bootstrap',
  );
}

bootstrap().catch(exitOnBootstrapError(SERVICE_NAME));
