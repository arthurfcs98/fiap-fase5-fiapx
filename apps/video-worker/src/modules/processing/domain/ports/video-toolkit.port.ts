import type { VideoProbe } from '../video-probe';

/** Injection token of {@link IVideoToolkit}. */
export const VIDEO_TOOLKIT = Symbol('VIDEO_TOOLKIT');

export interface MediaToolRunOptions {
  /** The process is killed (SIGKILL) when it runs longer than this. */
  timeoutMs: number;
}

/**
 * Port for the media tools (ffprobe/ffmpeg). Failures are reported as `MediaToolError`, so the
 * use case can classify them without knowing about processes or exit codes.
 */
export interface IVideoToolkit {
  /** Reads container/stream information. @throws MediaToolError */
  probe(sourcePath: string, options: MediaToolRunOptions): Promise<VideoProbe>;
  /**
   * Extracts one frame per second into `framesDir/frame_%04d.png` (base project semantics).
   * @throws MediaToolError
   */
  extractFrames(sourcePath: string, framesDir: string, options: MediaToolRunOptions): Promise<void>;
}
