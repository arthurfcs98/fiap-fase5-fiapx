import {
  correlationIdMiddleware,
  createHttpMetricsMiddleware,
  METRICS_REGISTRY,
} from '@fiapx/observability';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Registry } from '@prometheus-io/client';
import type { HelmetOptions } from 'helmet';
import helmet from 'helmet';
import type { ApiConfig } from './config/api.config';
import { API_PREFIX, BEARER_AUTH } from './shared/interfaces/http.constants';

export { API_PREFIX, BEARER_AUTH };

/**
 * `X-Forwarded-For` is only trusted from private/loopback peers (ingress-nginx, Caddy, the
 * compose network). A client connecting directly from the internet cannot spoof its IP, which
 * keys the login/register throttling.
 */
export const TRUSTED_PROXIES = 'loopback, linklocal, uniquelocal';

/** Headers the browser may send cross-origin / read back (when `CORS_ORIGIN` is set). */
const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'x-correlation-id',
];
const CORS_EXPOSED_HEADERS = ['x-correlation-id', 'Retry-After', 'Content-Disposition'];

export interface ConfigureAppOptions {
  /** Registry of `fiapx_http_request_duration_seconds`. Default: the app's `METRICS_REGISTRY`. */
  registry?: Registry;
}

/**
 * HTTP setup shared by `main.ts` and the E2E tests, so the tests run exactly the production
 * pipeline. Call BEFORE `init()`/`listen()`. Middleware order: correlation id (covers
 * everything, including the exception filter) → HTTP metrics (also measures 401/413/429 from
 * guards and the filter) → security headers → CORS.
 */
export function configureApp(
  app: NestExpressApplication,
  config: ApiConfig,
  options: ConfigureAppOptions = {},
): NestExpressApplication {
  app.set('trust proxy', TRUSTED_PROXIES);
  app.use(correlationIdMiddleware);
  const registry = options.registry ?? findMetricsRegistry(app);
  if (registry) app.use(createHttpMetricsMiddleware(registry));
  app.use(helmet(helmetOptions()));
  if (config.CORS_ORIGIN && config.CORS_ORIGIN.length > 0) {
    app.enableCors({
      origin: config.CORS_ORIGIN,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: CORS_ALLOWED_HEADERS,
      exposedHeaders: CORS_EXPOSED_HEADERS,
      maxAge: 600,
    });
  }
  app.setGlobalPrefix(API_PREFIX);
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  if (config.SWAGGER_ENABLED) setupSwagger(app, config);
  return app;
}

/**
 * Strict CSP for the static frontend: scripts only from the same origin (no inline script),
 * no framing. Inline styles stay allowed (Swagger UI and small style attributes in the UI).
 */
export function helmetOptions(): HelmetOptions {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  };
}

function findMetricsRegistry(app: NestExpressApplication): Registry | undefined {
  try {
    return app.get<Registry>(METRICS_REGISTRY, { strict: false });
  } catch {
    return undefined;
  }
}

/** Swagger at /api/docs (UI) and /api/docs-json, with the Bearer (JWT) scheme declared. */
export function setupSwagger(app: NestExpressApplication, config: ApiConfig): OpenAPIObject {
  const options = new DocumentBuilder()
    .setTitle('FIAP Frames: video-api')
    .setDescription(
      'Upload de vídeos, acompanhamento do processamento e download dos frames em .zip. ' +
        'Direitos do titular (LGPD) em /api/me.',
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
    customSiteTitle: 'FIAP Frames: video-api',
  });
  return document;
}
