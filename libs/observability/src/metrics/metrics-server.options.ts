import { ConfigurableModuleBuilder } from '@nestjs/common';

export interface MetricsServerModuleOptions {
  serviceName: string;
  version: string;
  port: number;
  host?: string;
  token?: string;
  defaultMetrics?: boolean;
}

/** Token do registry Prometheus do serviço (para registrar métricas `fiapx_*`). */
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');

/**
 * `isGlobal` (padrão `true`): o módulo é global, então qualquer módulo de feature (consumidores
 * de `libs/messaging`, módulos de vídeo) injeta {@link METRICS_REGISTRY} sem importar o
 * `forRoot` de novo, o que subiria um segundo servidor na mesma porta (EADDRINUSE).
 */
export const {
  ConfigurableModuleClass: MetricsServerConfigurableModule,
  MODULE_OPTIONS_TOKEN: METRICS_SERVER_OPTIONS,
} = new ConfigurableModuleBuilder<MetricsServerModuleOptions>()
  .setClassMethodName('forRoot')
  .setExtras({ isGlobal: true }, (definition, extras) => ({
    ...definition,
    global: extras.isGlobal,
  }))
  .build();
