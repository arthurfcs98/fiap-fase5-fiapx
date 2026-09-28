import { GlobalExceptionFilter, TypedConfigModule } from '@fiapx/common';
import {
  CorrelationIdInterceptor,
  createPinoConfig,
  MetricsServerModule,
} from '@fiapx/observability';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { ApiConfig } from './config/api.config';
import { API_CONFIG, apiConfigSchema, SERVICE_NAME } from './config/api.config';
import { HealthModule } from './modules/health/health.module';

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
    // /health e /metrics internos na porta METRICS_PORT (9464), fora do prefixo /api público.
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
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
  ],
})
export class AppModule {}
