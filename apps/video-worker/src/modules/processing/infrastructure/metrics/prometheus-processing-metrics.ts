import type { Registry } from '@prometheus-io/client';
import { Counter, Gauge, Histogram } from '@prometheus-io/client';
import type { IProcessingMetrics, JobResult } from '../../domain/ports/processing-metrics.port';
import { JOB_RESULTS } from '../../domain/ports/processing-metrics.port';

/** Worker metric names (contratos.md, section 11). */
export const WORKER_METRICS = {
  processingDuration: 'fiapx_video_processing_duration_seconds',
  inFlight: 'fiapx_worker_in_flight',
  jobs: 'fiapx_worker_jobs_total',
} as const;

/** 1 s to 10 min (`FFMPEG_TIMEOUT_MS` default). */
export const PROCESSING_DURATION_BUCKETS = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600];

type ResultLabel = 'result';

/** {@link IProcessingMetrics} registered in the service registry (`METRICS_REGISTRY`). */
export class PrometheusProcessingMetrics implements IProcessingMetrics {
  readonly duration: Histogram<ResultLabel>;
  readonly inFlight: Gauge;
  readonly jobs: Counter<ResultLabel>;

  constructor(registry: Registry) {
    this.duration = new Histogram<ResultLabel>({
      name: WORKER_METRICS.processingDuration,
      help: 'Time to process one video.uploaded message (download, ffprobe, ffmpeg, zip, publish), by result',
      labelNames: ['result'],
      buckets: PROCESSING_DURATION_BUCKETS,
      registers: [registry],
    });
    this.inFlight = new Gauge({
      name: WORKER_METRICS.inFlight,
      help: 'Videos being processed right now by this replica',
      registers: [registry],
    });
    this.jobs = new Counter<ResultLabel>({
      name: WORKER_METRICS.jobs,
      help: 'Processing jobs finished, by result (completed, duplicate, failed, retry)',
      labelNames: ['result'],
      registers: [registry],
    });
    // Every series exists from the first scrape, so rate()/increase() see the first event.
    for (const result of JOB_RESULTS) {
      this.jobs.inc({ result }, 0);
      this.duration.zero({ result });
    }
  }

  jobStarted(): void {
    this.inFlight.inc();
  }

  jobFinished(result: JobResult, durationSeconds: number): void {
    this.inFlight.dec();
    this.jobs.inc({ result });
    this.duration.observe({ result }, durationSeconds);
  }
}
