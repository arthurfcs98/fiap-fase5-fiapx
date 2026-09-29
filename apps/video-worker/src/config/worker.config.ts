import { baseServiceConfigShape } from '@fiapx/common';
import { messagingConfigShape } from '@fiapx/messaging';
import { metricsServerConfigShape } from '@fiapx/observability';
import { storageConfigShape } from '@fiapx/storage';
import { z } from 'zod';

export const SERVICE_NAME = 'video-worker';

/** Injection token of the validated video-worker configuration. */
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

/**
 * Worker variables (contratos.md, section 10): base + metrics + RabbitMQ + S3 + the
 * processing-specific ones.
 */
export const workerConfigSchema = z.object({
  ...baseServiceConfigShape,
  ...metricsServerConfigShape,
  ...messagingConfigShape,
  ...storageConfigShape,
  /** Unacked messages per replica (ffmpeg is CPU-bound: 1). */
  WORKER_PREFETCH: z.coerce.number().int().min(1).default(1),
  /** Scratch directory; each run uses `<WORK_DIR>/<videoId>/<runId>` and removes it at the end. */
  WORK_DIR: z.string().min(1).default('/work'),
  /** ffmpeg time budget (SIGKILL when exceeded). */
  FFMPEG_TIMEOUT_MS: z.coerce.number().int().min(1).default(600_000),
  /** Longest accepted video (ffprobe), in seconds. */
  MAX_VIDEO_DURATION_S: z.coerce.number().positive().default(600),
  /**
   * Frames of one video on the work disk, in MiB: past it ffmpeg is stopped and the video
   * fails with P0006. Below the `/work` size (K8s emptyDir 2 GiB: a full one evicts the pod).
   */
  MAX_FRAMES_MB: z.coerce.number().int().min(1).default(1536),
});

export type WorkerConfig = z.output<typeof workerConfigSchema>;
