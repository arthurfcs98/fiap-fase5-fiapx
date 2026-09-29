export type MediaTool = 'ffprobe' | 'ffmpeg';

/**
 * How an external media tool failed. The application layer turns each kind into a transient
 * or permanent processing error:
 * - `timeout`: our time budget expired and the process was SIGKILLed (AbortController);
 * - `killed`: terminated by a signal we did not send (typically the cgroup OOM killer) or
 *   interrupted (ffmpeg exit code 255);
 * - `no_space`: the scratch disk filled up (`ENOSPC`);
 * - `unavailable`: the binary could not be started (not installed, no permission);
 * - `failed`: non-zero exit code, i.e. ffmpeg/ffprobe rejected the input.
 */
export type MediaToolFailure = 'timeout' | 'killed' | 'no_space' | 'unavailable' | 'failed';

export class MediaToolError extends Error {
  constructor(
    public readonly tool: MediaTool,
    public readonly failure: MediaToolFailure,
    /** Diagnostic text (exit code, signal, stderr tail). Never shown to end users. */
    public readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`${tool} ${failure}: ${detail}`, options);
    this.name = 'MediaToolError';
  }
}
