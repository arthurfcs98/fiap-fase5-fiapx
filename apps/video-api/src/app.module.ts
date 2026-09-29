import { createTypeOrmOptions, GlobalExceptionFilter, TypedConfigModule } from '@fiapx/common';
import { MessagingModule } from '@fiapx/messaging';
import {
  CorrelationIdInterceptor,
  createPinoConfig,
  MetricsServerModule,
} from '@fiapx/observability';
import { storageOptionsFromConfig, StorageModule } from '@fiapx/storage';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import type Redis from 'ioredis';
import { LoggerModule } from 'nestjs-pino';
import type { ApiConfig } from './config/api.config';
import { API_CONFIG, apiConfigSchema, SERVICE_NAME } from './config/api.config';
import { MIGRATIONS } from './database/migrations';
import { ORM_ENTITIES } from './database/orm-entities';
import { PersistenceModule } from './database/persistence.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { VideosModule } from './modules/videos/videos.module';
import { FailOpenThrottlerStorage } from './shared/infrastructure/throttling/fail-open-throttler.storage';
import { REDIS_CLIENT } from './shared/infrastructure/redis/redis.constants';
import {
  buildLoginIpThrottler,
  buildThrottler,
  DEFAULT_THROTTLE_LIMITS,
} from './shared/infrastructure/throttling/throttle';
import { SharedModule } from './shared/shared.module';
import { resolvePublicDir } from './static-assets';

/** S3 part size of the API uploads (the S3 minimum). */
export const API_UPLOAD_PART_BYTES = 5 * 1024 * 1024;

/**
 * video-api (contratos.md, sections 3, 5, 8, 12 and 13). Global infrastructure first (config,
 * logs, metrics server, messaging, storage, database, Redis, schedule, throttling, static
 * frontend), then the feature modules.
 */
@Module({
  imports: [
    TypedConfigModule.forRoot({ token: API_CONFIG, schema: apiConfigSchema }),
    LoggerModule.forRootAsync({
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        createPinoConfig({
          serviceName: SERVICE_NAME,
          version: config.APP_VERSION,
          level: config.LOG_LEVEL,
        }),
    }),
    // /health and /metrics on METRICS_PORT (9464), outside the public /api prefix.
    MetricsServerModule.forRootAsync({
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => ({
        serviceName: SERVICE_NAME,
        version: config.APP_VERSION,
        port: config.METRICS_PORT,
        host: config.METRICS_HOST,
        token: config.METRICS_TOKEN,
      }),
    }),
    // Does not block the boot with RabbitMQ down: uploads keep working through the outbox.
    MessagingModule.forRootAsync({
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => ({
        url: config.RABBITMQ_URL,
        connectionName: SERVICE_NAME,
      }),
    }),
    // Uploads stream to S3 with 5 MiB parts, 1 in flight (~10 MiB of buffers per upload):
    // together with MAX_CONCURRENT_UPLOADS it bounds the memory of the pod.
    StorageModule.forRootAsync({
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => ({
        ...storageOptionsFromConfig(config),
        partSizeBytes: API_UPLOAD_PART_BYTES,
        queueSize: 1,
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        createTypeOrmOptions(config, {
          applicationName: SERVICE_NAME,
          entities: ORM_ENTITIES,
          migrations: MIGRATIONS,
        }),
    }),
    SharedModule,
    PersistenceModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT, API_CONFIG],
      useFactory: (redis: Redis, config: ApiConfig) => ({
        // Routes opt in with @ThrottleBy(name) (register, login, upload, DELETE /api/me).
        throttlers: [
          buildThrottler({
            ...DEFAULT_THROTTLE_LIMITS,
            register: config.THROTTLE_REGISTER_LIMIT,
            login: config.THROTTLE_LOGIN_LIMIT,
            upload: config.THROTTLE_UPLOAD_LIMIT,
          }),
          // Login only: per IP whatever the e-mail (bcrypt CPU budget).
          buildLoginIpThrottler(config.THROTTLE_LOGIN_IP_LIMIT),
        ],
        storage: new FailOpenThrottlerStorage(new ThrottlerStorageRedisService(redis)),
        errorMessage: 'Muitas requisições. Aguarde alguns instantes e tente de novo.',
      }),
    }),
    // Static frontend at "/" (login, sign-up, upload, list, download, /privacidade.html).
    ServeStaticModule.forRoot({
      rootPath: resolvePublicDir(),
      renderPath: '/',
      exclude: ['/api/{*path}'],
      serveStaticOptions: { index: 'index.html', fallthrough: true },
    }),
    AuthModule,
    VideosModule,
    OutboxModule,
    PrivacyModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
  ],
})
export class AppModule {}
