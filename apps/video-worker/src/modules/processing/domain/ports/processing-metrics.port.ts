/** Injection token of {@link IProcessingMetrics}. */
export const PROCESSING_METRICS = Symbol('PROCESSING_METRICS');

/**
 * `result` label of `fiapx_worker_jobs_total` and `fiapx_video_processing_duration_seconds`:
 * - `completed`: zip uploaded and `video.processing.completed` confirmed;
 * - `duplicate`: the zip already existed (idempotency), `completed` republished, ffmpeg skipped;
 * - `failed`: permanent error (P0001/P0002/P0003/P0004/P0005), `video.processing.failed` follows;
 * - `retry`: transient error, the message goes to the next `.retry.N` queue (or the DLX).
 */
export const JOB_RESULTS = ['completed', 'duplicate', 'failed', 'retry'] as const;

export type JobResult = (typeof JOB_RESULTS)[number];

/** Port for the worker business metrics (contratos.md, section 11). */
export interface IProcessingMetrics {
  /** A job began (`fiapx_worker_in_flight` +1). */
  jobStarted(): void;
  /** A job ended (`in_flight` -1, `jobs_total{result}` +1, duration observed). */
  jobFinished(result: JobResult, durationSeconds: number): void;
}
