import { hostname } from 'node:os';
import type { WorkerConfig } from '../../../config/worker.config';

/** Injection token of {@link ProcessingSettings}. */
export const PROCESSING_SETTINGS = Symbol('PROCESSING_SETTINGS');

/** ffprobe only reads headers: 30 s is plenty even under CPU contention. */
export const FFPROBE_TIMEOUT_MS = 30_000;

/** `workerId` limit of `video.processing.started`. */
const WORKER_ID_MAX_LENGTH = 100;

/** Runtime settings of the processing pipeline (derived from the validated config). */
export interface ProcessingSettings {
  /** Reported in `video.processing.started` (pod/container hostname). */
  workerId: string;
  ffmpegTimeoutMs: number;
  ffprobeTimeoutMs: number;
  maxVideoDurationS: number;
  /** Most bytes of frames one video may put on the work disk (`MAX_FRAMES_MB`). */
  maxFramesBytes: number;
  /**
   * Age from which the startup sweep removes job folders. `WORK_DIR` is private to the replica
   * (contratos.md, section 15: tmpfs/emptyDir per replica, never a shared volume) and nothing
   * runs before the sweep, so everything found at boot is a leftover of the previous process
   * (e.g. frames of a job killed by OOM): 0 = remove all.
   */
  staleWorkDirMs: number;
  /** How long SIGTERM waits for the job in progress (see {@link shutdownTimeoutMsFor}). */
  shutdownTimeoutMs: number;
}

/** Download, zip upload and publish on top of ffprobe + ffmpeg (worst case, no contention). */
export const SHUTDOWN_TRANSFER_MARGIN_MS = 60_000;

/**
 * SIGTERM waits for the whole job in progress (contratos.md, section 9): ffprobe + ffmpeg at
 * their time budgets plus the transfers. `terminationGracePeriodSeconds` (K8s) and
 * `stop_grace_period` (compose) must be larger (720 s with the defaults: 30 + 600 + 60 = 690 s).
 */
export function shutdownTimeoutMsFor(config: Pick<WorkerConfig, 'FFMPEG_TIMEOUT_MS'>): number {
  return (
    Math.min(FFPROBE_TIMEOUT_MS, config.FFMPEG_TIMEOUT_MS) +
    config.FFMPEG_TIMEOUT_MS +
    SHUTDOWN_TRANSFER_MARGIN_MS
  );
}

export function processingSettingsFromConfig(
  config: Pick<WorkerConfig, 'FFMPEG_TIMEOUT_MS' | 'MAX_VIDEO_DURATION_S' | 'MAX_FRAMES_MB'>,
  host: string = hostname(),
): ProcessingSettings {
  const workerId = host.trim().slice(0, WORKER_ID_MAX_LENGTH);
  return {
    workerId: workerId.length > 0 ? workerId : 'video-worker',
    ffmpegTimeoutMs: config.FFMPEG_TIMEOUT_MS,
    ffprobeTimeoutMs: Math.min(FFPROBE_TIMEOUT_MS, config.FFMPEG_TIMEOUT_MS),
    maxVideoDurationS: config.MAX_VIDEO_DURATION_S,
    maxFramesBytes: config.MAX_FRAMES_MB * 1024 * 1024,
    staleWorkDirMs: 0,
    shutdownTimeoutMs: shutdownTimeoutMsFor(config),
  };
}
