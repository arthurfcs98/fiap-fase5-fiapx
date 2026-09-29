import { NonRetryableError, ProcessingErrors, RetryableError } from '@fiapx/common';
import { ObjectStorageError } from '@fiapx/storage';
import type { MediaToolError } from '../domain/media-tool.error';

/** Error types the consumer runner understands (contratos.md, "Regras de consumo"). */
export type ProcessingFailure = RetryableError | NonRetryableError;

export interface MediaToolFailureContext {
  /** `x-retry-count` of the message (0 on the first attempt). */
  retryCount: number;
  /** Time budget of the tool that failed (reported in P0004). */
  timeoutMs: number;
}

/**
 * Maps a media tool failure to the queue semantics:
 * - timeout on the first attempt → transient (may be CPU contention); on later attempts → P0004;
 * - killed by a signal we did not send (OOM), binary missing → transient;
 * - disk full → P0006: `/work` is private to the replica and holds one job at a time (the
 *   startup sweep empties it), so the frames of THIS video do not fit; retrying only burns
 *   four ffmpeg runs;
 * - cancelled by the caller (delivery abandoned) → transient (the runner discards it anyway);
 * - non-zero exit code → P0001 (ffmpeg/ffprobe rejected the input).
 */
export function classifyMediaToolError(
  error: MediaToolError,
  context: MediaToolFailureContext,
): ProcessingFailure {
  const tool = error.tool.toUpperCase();
  switch (error.failure) {
    case 'timeout':
      return context.retryCount === 0
        ? new RetryableError(`${tool}_TIMEOUT after ${context.timeoutMs} ms (first attempt)`, {
            cause: error,
          })
        : ProcessingErrors.FFMPEG_TIMEOUT(context.timeoutMs);
    case 'killed':
      return new RetryableError(`${tool}_KILLED: ${error.detail}`, { cause: error });
    case 'no_space':
      return ProcessingErrors.OUTPUT_TOO_LARGE(`WORK_DIR_FULL: ${error.detail}`);
    case 'aborted':
      return new RetryableError(`${tool}_ABORTED: ${error.detail}`, { cause: error });
    case 'unavailable':
      return new RetryableError(`${tool}_UNAVAILABLE: ${error.detail}`, { cause: error });
    case 'failed':
      return ProcessingErrors.INVALID_VIDEO(error.detail);
  }
}

/**
 * Last-resort mapping for anything the pipeline did not classify: storage failures and
 * unexpected errors are transient (retry, then DLX → P0099 in the video-api).
 */
export function toProcessingFailure(error: unknown): ProcessingFailure {
  if (error instanceof NonRetryableError || error instanceof RetryableError) return error;
  if (error instanceof ObjectStorageError) {
    return new RetryableError(`STORAGE_UNAVAILABLE: ${error.message}`, { cause: error });
  }
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new RetryableError(`UNEXPECTED: ${detail}`, { cause: error });
}
