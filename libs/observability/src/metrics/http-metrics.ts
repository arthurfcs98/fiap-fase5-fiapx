import type { Registry } from '@prometheus-io/client';
import { Histogram } from '@prometheus-io/client';

/** contratos.md, seção 13: base dos SLOs de disponibilidade e de latência do upload. */
export const HTTP_REQUEST_DURATION_SECONDS = 'fiapx_http_request_duration_seconds';

/**
 * Buckets em segundos. Têm limite exato em `5` (SLO: p95 de `POST /api/videos` < 5 s), então
 * `le="5"` responde "quantas requisições cumpriram o SLO" sem interpolação; a cauda vai até 2 min
 * porque o upload (até 95 MB) é medido do primeiro byte até a resposta.
 */
export const HTTP_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
];

export type HttpMetricLabel = 'method' | 'route' | 'status';

export interface HttpObservation {
  method: string;
  /** Padrão de rota do Nest (ex.: `/api/videos/:id`), nunca a URL crua. */
  route: string;
  status: number | string;
}

/**
 * `fiapx_http_request_duration_seconds{method,route,status}` no registry do serviço
 * (`METRICS_REGISTRY`). Reaproveita o histograma se ele já estiver registrado (várias instâncias
 * no mesmo registry, ex.: testes E2E que sobem o app mais de uma vez).
 */
export class HttpMetrics {
  readonly requestDuration: Histogram<HttpMetricLabel>;

  constructor(registry: Registry) {
    const existing = registry.getSingleMetric(HTTP_REQUEST_DURATION_SECONDS);
    this.requestDuration =
      existing instanceof Histogram
        ? existing
        : new Histogram<HttpMetricLabel>({
            name: HTTP_REQUEST_DURATION_SECONDS,
            help: 'Duração das requisições HTTP, por método, padrão de rota e status',
            labelNames: ['method', 'route', 'status'],
            buckets: [...HTTP_DURATION_BUCKETS],
            registers: [registry],
          });
  }

  observe(labels: HttpObservation, seconds: number): void {
    this.requestDuration.observe(
      { method: labels.method, route: labels.route, status: String(labels.status) },
      seconds,
    );
  }

  /**
   * Quantas requisições foram observadas com os labels informados (soma dos `_count` que casam;
   * label omitido = qualquer valor). Para testes e diagnóstico.
   */
  async requestCount(
    labels: Partial<Record<HttpMetricLabel, string | number>> = {},
  ): Promise<number> {
    const { values } = await this.requestDuration.get();
    return values
      .filter((value) => value.metricName === `${HTTP_REQUEST_DURATION_SECONDS}_count`)
      .filter((value) =>
        Object.entries(labels).every(
          ([name, expected]) =>
            String((value.labels as Record<string, unknown>)[name]) === String(expected),
        ),
      )
      .reduce((total, value) => total + value.value, 0);
  }
}
