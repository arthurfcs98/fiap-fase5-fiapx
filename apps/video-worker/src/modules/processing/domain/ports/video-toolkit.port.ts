import type { VideoProbe } from '../video-probe';

/** Injection token of {@link IVideoToolkit}. */
export const VIDEO_TOOLKIT = Symbol('VIDEO_TOOLKIT');

export interface MediaToolRunOptions {
  /** The process is killed (SIGKILL) when it runs longer than this. */
  timeoutMs: number;
  /** Aborting it kills the process (the delivery was abandoned: channel closed). */
  signal?: AbortSignal;
}

/** Output bounds of the frame extraction ({@link FRAME_OUTPUT_LIMITS}). */
export interface ExtractFramesOptions extends MediaToolRunOptions {
  /** ffmpeg stops after this many frames (`-frames:v`). */
  frameLimit: number;
  /** Frames larger than this (longest side, px) are scaled down, keeping the aspect ratio. */
  maxDimension: number;
  /**
   * ffmpeg is stopped once the frames on disk pass this many bytes (`MediaToolError`
   * `no_space`): a noisy high-resolution video can produce more PNG bytes than the work disk
   * holds, and in K8s a full emptyDir evicts the pod instead of failing the write.
   */
  maxTotalBytes: number;
}

/**
 * Port for the media tools (ffprobe/ffmpeg). Failures are reported as `MediaToolError`, so the
 * use case can classify them without knowing about processes or exit codes.
 */
export interface IVideoToolkit {
  /** Reads container/stream information. @throws MediaToolError */
  probe(sourcePath: string, options: MediaToolRunOptions): Promise<VideoProbe>;
  /**
   * Extracts one frame per second into `framesDir/frame_%04d.png` (base project semantics),
   * at most `frameLimit` frames, scaled down to `maxDimension` on the longest side, and at
   * most `maxTotalBytes` on disk.
   * @throws MediaToolError
   */
  extractFrames(
    sourcePath: string,
    framesDir: string,
    options: ExtractFramesOptions,
  ): Promise<void>;
}
