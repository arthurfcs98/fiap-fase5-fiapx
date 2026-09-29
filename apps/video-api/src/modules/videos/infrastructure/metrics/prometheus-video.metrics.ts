import type { Registry } from '@prometheus-io/client';
import { Counter } from '@prometheus-io/client';
import type { VideoMetrics } from '../../application/ports/video.metrics';

/** contratos.md, section 11. */
export const VIDEOS_UPLOADED_TOTAL = 'fiapx_videos_uploaded_total';
export const VIDEOS_COMPLETED_TOTAL = 'fiapx_videos_completed_total';
export const VIDEOS_FAILED_TOTAL = 'fiapx_videos_failed_total';

/**
 * Business counters on the service registry (`METRICS_REGISTRY`, exposed on `:9464/metrics`).
 * The only label is the error code: no personal data ever becomes a label.
 */
export class PrometheusVideoMetrics implements VideoMetrics {
  readonly uploadedTotal: Counter;
  readonly completedTotal: Counter;
  readonly failedTotal: Counter<'error_code'>;

  constructor(registry: Registry) {
    this.uploadedTotal = counter(registry, VIDEOS_UPLOADED_TOTAL, 'Vídeos aceitos no upload (202)');
    this.completedTotal = counter(
      registry,
      VIDEOS_COMPLETED_TOTAL,
      'Vídeos que chegaram a COMPLETED',
    );
    this.failedTotal = counter(
      registry,
      VIDEOS_FAILED_TOTAL,
      'Vídeos que chegaram a FAILED, por código de erro',
      ['error_code'],
    );
  }

  uploaded(): void {
    this.uploadedTotal.inc();
  }

  completed(): void {
    this.completedTotal.inc();
  }

  failed(errorCode: string): void {
    this.failedTotal.inc({ error_code: errorCode });
  }
}

function counter<T extends string>(
  registry: Registry,
  name: string,
  help: string,
  labelNames: T[] = [],
): Counter<T> {
  const existing = registry.getSingleMetric(name);
  if (existing instanceof Counter) return existing;
  return new Counter<T>({ name, help, labelNames, registers: [registry] });
}
