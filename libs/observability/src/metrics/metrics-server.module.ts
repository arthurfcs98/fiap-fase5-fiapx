import { Module } from '@nestjs/common';
import { createMetricsRegistry } from './metrics-registry';
import type { MetricsServerModuleOptions } from './metrics-server.options';
import {
  METRICS_REGISTRY,
  METRICS_SERVER_OPTIONS,
  MetricsServerConfigurableModule,
} from './metrics-server.options';
import { MetricsServerService } from './metrics-server.service';

/**
 * `MetricsServerModule.forRoot({...})` ou `.forRootAsync({ inject, useFactory })`, UMA vez no
 * módulo raiz: servidor interno de /health e /metrics. O módulo é global (ver
 * `metrics-server.options.ts`): os demais módulos só injetam `METRICS_REGISTRY`.
 */
@Module({
  providers: [
    {
      provide: METRICS_REGISTRY,
      inject: [METRICS_SERVER_OPTIONS],
      useFactory: (options: MetricsServerModuleOptions) =>
        createMetricsRegistry(options.serviceName, { defaultMetrics: options.defaultMetrics }),
    },
    MetricsServerService,
  ],
  exports: [METRICS_REGISTRY, MetricsServerService],
})
export class MetricsServerModule extends MetricsServerConfigurableModule {}
