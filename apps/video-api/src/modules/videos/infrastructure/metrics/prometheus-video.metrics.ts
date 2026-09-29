import { PROCESSING_ERROR_CODES } from '@fiapx/common';
import type { Registry } from '@prometheus-io/client';
import { Counter, Gauge, Histogram } from '@prometheus-io/client';
import type { VideoMetrics } from '../../application/ports/video.metrics';
import type { VideoRepository } from '../../domain/video.repository';

/** contratos.md, section 11. */
export const VIDEOS_UPLOADED_TOTAL = 'fiapx_videos_uploaded_total';
export const VIDEOS_COMPLETED_TOTAL = 'fiapx_videos_completed_total';
export const VIDEOS_FAILED_TOTAL = 'fiapx_videos_failed_total';
export const ZIP_STORAGE_BYTES = 'fiapx_zip_storage_bytes';
export const VIDEO_TURNAROUND_SECONDS = 'fiapx_video_turnaround_seconds';

/** Upload → COMPLETED, 10 s to 2 h; exact bucket at 300 s (the SLO target). */
export const TURNAROUND_BUCKETS = [10, 30, 60, 120, 300, 600, 1800, 3600, 7200];

/**
 * Business counters on the service registry (`METRICS_REGISTRY`, exposed on `:9464/metrics`).
 * The only label is the error code: no personal data ever becomes a label. Every
 * `error_code` series starts at 0 on boot: `increase()` only sees an increment between two
 * samples, so a series born with the first failure would hide it from the pipeline SLO.
 */
export class PrometheusVideoMetrics implements VideoMetrics {
  readonly uploadedTotal: Counter;
  readonly completedTotal: Counter;
  readonly failedTotal: Counter<'error_code'>;
  readonly turnaround: Histogram;

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
    for (const code of PROCESSING_ERROR_CODES) this.failedTotal.inc({ error_code: code }, 0);
    const existing = registry.getSingleMetric(VIDEO_TURNAROUND_SECONDS);
    this.turnaround =
      existing instanceof Histogram
        ? existing
        : new Histogram({
            name: VIDEO_TURNAROUND_SECONDS,
            help: 'Tempo do upload até COMPLETED (inclui a espera na fila), em segundos',
            buckets: TURNAROUND_BUCKETS,
            registers: [registry],
          });
  }

  uploaded(): void {
    this.uploadedTotal.inc();
  }

  completed(turnaroundSeconds: number): void {
    this.completedTotal.inc();
    this.turnaround.observe(Math.max(0, turnaroundSeconds));
  }

  failed(errorCode: string): void {
    this.failedTotal.inc({ error_code: errorCode });
  }
}

/**
 * `fiapx_zip_storage_bytes`: bytes of the zips still stored (not expired), from the database at
 * scrape time; the `fiapx-zips` bucket has a size quota and a full bucket fails videos with
 * P0007 (alert `FiapxZipStorageHigh`). If the database is down the last value is kept.
 */
export function registerZipStorageGauge(
  registry: Registry,
  videos: Pick<VideoRepository, 'sumStoredZipBytes'>,
): Gauge {
  const existing = registry.getSingleMetric(ZIP_STORAGE_BYTES);
  if (existing instanceof Gauge) return existing;
  return new Gauge({
    name: ZIP_STORAGE_BYTES,
    help: 'Bytes dos zips ainda guardados no bucket fiapx-zips (não expirados)',
    registers: [registry],
    async collect() {
      try {
        this.set(await videos.sumStoredZipBytes());
      } catch {
        // keep the previous value
      }
    },
  });
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
