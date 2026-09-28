import { collectDefaultMetrics, Registry } from '@prometheus-io/client';

export interface MetricsRegistryOptions {
  /** Métricas padrão do processo Node (CPU, memória, event loop, GC). Padrão: true. */
  defaultMetrics?: boolean;
}

/**
 * Cria um registry Prometheus isolado (não usa o global) com o label `service` em todas as
 * séries. Métricas de negócio `fiapx_*` serão registradas nele a partir da E2.
 */
export function createMetricsRegistry(
  serviceName: string,
  options: MetricsRegistryOptions = {},
): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  if (options.defaultMetrics ?? true) {
    collectDefaultMetrics({ register: registry });
  }
  return registry;
}
