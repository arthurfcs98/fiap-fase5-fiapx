import { baseServiceConfigShape } from '@fiapx/common';
import { messagingConfigShape } from '@fiapx/messaging';
import { metricsServerConfigShape } from '@fiapx/observability';
import { storageConfigShape } from '@fiapx/storage';
import { z } from 'zod';

export const SERVICE_NAME = 'video-worker';

/** Injection token of the validated video-worker configuration. */
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

/**
 * How long SIGTERM waits for the video being processed before closing the channel (anything
 * left unacked goes back to the queue). `stop_grace_period` / `terminationGracePeriodSeconds`
 * must be larger (330 s in compose).
 */
export const WORKER_SHUTDOWN_TIMEOUT_MS = 300_000;

/**
 * Worker variables (contratos.md, section 10): base + metrics + RabbitMQ + S3 + the four
 * processing-specific ones.
 */
export const workerConfigSchema = z.object({
  ...baseServiceConfigShape,
  ...metricsServerConfigShape,
  ...messagingConfigShape,
  ...storageConfigShape,
  /** Unacked messages per replica (ffmpeg is CPU-bound: 1). */
  WORKER_PREFETCH: z.coerce.number().int().min(1).default(1),
  /** Scratch directory; each job uses `<WORK_DIR>/<videoId>` and removes it at the end. */
  WORK_DIR: z.string().min(1).default('/work'),
  /** ffmpeg time budget (SIGKILL when exceeded). */
  FFMPEG_TIMEOUT_MS: z.coerce.number().int().min(1).default(600_000),
  /** Longest accepted video (ffprobe), in seconds. */
  MAX_VIDEO_DURATION_S: z.coerce.number().positive().default(600),
});

export type WorkerConfig = z.output<typeof workerConfigSchema>;
