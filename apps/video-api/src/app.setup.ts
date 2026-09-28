import { correlationIdMiddleware } from '@fiapx/observability';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { ApiConfig } from './config/api.config';

export const API_PREFIX = 'api';
export const BEARER_AUTH = 'bearer';

/**
 * Configuração HTTP compartilhada entre `main.ts` e os testes E2E, para que o teste suba
 * exatamente a mesma aplicação que roda em produção. Chamar ANTES de `init()`/`listen()`.
 */
export function configureApp(
  app: NestExpressApplication,
  config: ApiConfig,
): NestExpressApplication {
  // Primeiro middleware da cadeia: o contexto de correlação cobre pino-http, guards, pipes,
  // handler e o filtro global de exceções (o log do 5xx sai com `correlationId`).
  app.use(correlationIdMiddleware);
  app.setGlobalPrefix(API_PREFIX);
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  if (config.SWAGGER_ENABLED) setupSwagger(app, config);
  return app;
}

/** Swagger em /api/docs (UI) e /api/docs-json, com esquema Bearer (JWT) já declarado. */
export function setupSwagger(app: NestExpressApplication, config: ApiConfig): OpenAPIObject {
  const options = new DocumentBuilder()
    .setTitle('FIAP X: video-api')
    .setDescription(
      'Upload de vídeos, acompanhamento do processamento e download dos frames em .zip.',
    )
    .setVersion(config.APP_VERSION)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Token obtido em POST /api/auth/login',
      },
      BEARER_AUTH,
    )
    .build();

  const document = SwaggerModule.createDocument(app, options);
  SwaggerModule.setup('docs', app, document, {
    useGlobalPrefix: true,
    jsonDocumentUrl: 'docs-json',
    customSiteTitle: 'FIAP X: video-api',
  });
  return document;
}
