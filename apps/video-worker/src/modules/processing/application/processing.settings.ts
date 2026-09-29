import { hostname } from 'node:os';
import type { WorkerConfig } from '../../../config/worker.config';

/** Injection token of {@link ProcessingSettings}. */
export const PROCESSING_SETTINGS = Symbol('PROCESSING_SETTINGS');

/** ffprobe only reads headers: 30 s is plenty even under CPU contention. */
export const FFPROBE_TIMEOUT_MS = 30_000;

/** Minimum age before the startup sweep removes a leftover work directory. */
export const MIN_STALE_WORK_DIR_MS = 60 * 60 * 1000;

/** `workerId` limit of `video.processing.started`. */
const WORKER_ID_MAX_LENGTH = 100;

/** Runtime settings of the processing pipeline (derived from the validated config). */
export interface ProcessingSettings {
  /** Reported in `video.processing.started` (pod/container hostname). */
  workerId: string;
  ffmpegTimeoutMs: number;
  ffprobeTimeoutMs: number;
  maxVideoDurationS: number;
  /** Work directories older than this are leftovers of a dead process. */
  staleWorkDirMs: number;
}

export function processingSettingsFromConfig(
  config: Pick<WorkerConfig, 'FFMPEG_TIMEOUT_MS' | 'MAX_VIDEO_DURATION_S'>,
  host: string = hostname(),
): ProcessingSettings {
  const workerId = host.trim().slice(0, WORKER_ID_MAX_LENGTH);
  return {
    workerId: workerId.length > 0 ? workerId : 'video-worker',
    ffmpegTimeoutMs: config.FFMPEG_TIMEOUT_MS,
    ffprobeTimeoutMs: Math.min(FFPROBE_TIMEOUT_MS, config.FFMPEG_TIMEOUT_MS),
    maxVideoDurationS: config.MAX_VIDEO_DURATION_S,
    // A live job never gets this old: ffmpeg is killed at FFMPEG_TIMEOUT_MS.
    staleWorkDirMs: Math.max(MIN_STALE_WORK_DIR_MS, 2 * config.FFMPEG_TIMEOUT_MS),
  };
}
