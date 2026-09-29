import { join } from 'node:path';
import { FRAME_FILE_PATTERN } from '../../domain/frames';
import type { MediaTool, MediaToolFailure } from '../../domain/media-tool.error';
import { MediaToolError } from '../../domain/media-tool.error';
import type {
  ExtractFramesOptions,
  IVideoToolkit,
  MediaToolRunOptions,
} from '../../domain/ports/video-toolkit.port';
import type { VideoProbe } from '../../domain/video-probe';
import { directorySizeBytes } from '../filesystem/directory-size';
import type { ProcessRunner, ProcessRunOptions, ProcessRunResult } from '../process/process-runner';
import { parseFfprobeOutput } from './ffprobe-output.parser';

/** How often the frames folder is measured while ffmpeg runs (default). */
export const FRAMES_SIZE_POLL_MS = 1_000;

export interface FfmpegToolkitOptions {
  /** Default: `ffmpeg` (from PATH). */
  ffmpegPath?: string;
  /** Default: `ffprobe` (from PATH). */
  ffprobePath?: string;
  /** Default: `nice` (from PATH). */
  nicePath?: string;
  /** `nice -n <value>` for ffmpeg (lower CPU priority on the shared VM). `null` disables. Default: 10. */
  niceness?: number | null;
  /** Measures the frames folder in bytes. Default: {@link directorySizeBytes}. */
  measureDir?: (dir: string) => Promise<number>;
  /** Default: {@link FRAMES_SIZE_POLL_MS}. */
  sizePollMs?: number;
}

/**
 * Demuxers ffprobe/ffmpeg may use (`-format_whitelist`): the containers of the accepted upload
 * extensions (`.mp4 .mov .mkv .webm .avi .wmv .flv`). Any other format (HLS playlist, image,
 * concat...) is refused by the demuxer itself, before it parses anything.
 */
export const FORMAT_WHITELIST = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,asf,flv';

/**
 * ffmpeg arguments: the base project command (`-i <video> -vf fps=1 -y frame_%04d.png`) plus
 * `-nostdin` (never waits for the terminal), `-protocol_whitelist file` and `-format_whitelist`
 * (a crafted input cannot open network URLs or unexpected demuxers), `-threads 2`
 * (contratos.md, section 9), quiet logs (only errors reach the stderr tail) and the output
 * bounds: at most `frameLimit` frames, scaled down to `maxDimension` on the longest side.
 */
export function ffmpegArgs(
  sourcePath: string,
  framesDir: string,
  limits: Pick<ExtractFramesOptions, 'frameLimit' | 'maxDimension'>,
): string[] {
  const size = String(limits.maxDimension);
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-protocol_whitelist',
    'file',
    '-format_whitelist',
    FORMAT_WHITELIST,
    '-i',
    sourcePath,
    '-vf',
    `fps=1,scale=w='min(iw,${size})':h='min(ih,${size})':force_original_aspect_ratio=decrease`,
    '-frames:v',
    String(limits.frameLimit),
    '-threads',
    '2',
    '-y',
    join(framesDir, FRAME_FILE_PATTERN),
  ];
}

/** ffprobe arguments: JSON with container and streams, local files, whitelisted demuxers. */
export function ffprobeArgs(sourcePath: string): string[] {
  return [
    '-v',
    'error',
    '-protocol_whitelist',
    'file',
    '-format_whitelist',
    FORMAT_WHITELIST,
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    sourcePath,
  ];
}

/** ffmpeg exit statuses are `AVERROR(errno) & 0xff`: ENOSPC (28) → 228. */
const EXIT_NO_SPACE = 228;
/** ffmpeg exits with 255 when interrupted by a signal (SIGTERM/SIGINT). */
const EXIT_INTERRUPTED = 255;
/** `nice` could not execute the binary (126: not executable, 127: not found). */
const EXIT_NOT_EXECUTABLE = new Set([126, 127]);
const NO_SPACE_MESSAGE = /no space left on device/i;
const DETAIL_MAX_LENGTH = 300;

/**
 * Classifies how a media tool run ended; `undefined` means success (exit code 0).
 * Exported for unit tests of every branch.
 */
export function classifyRun(
  result: ProcessRunResult,
): { failure: MediaToolFailure; detail: string } | undefined {
  if (result.aborted) {
    return { failure: 'aborted', detail: `cancelled after ${result.durationMs} ms` };
  }
  if (result.timedOut) {
    return { failure: 'timeout', detail: `killed after ${result.durationMs} ms` };
  }
  if (result.signal !== null) {
    return { failure: 'killed', detail: `terminated by ${result.signal}` };
  }
  if (result.exitCode === 0) return undefined;

  const detail = `exit code ${String(result.exitCode)}: ${summarize(result.stderrTail)}`;
  if (result.exitCode === EXIT_NO_SPACE || NO_SPACE_MESSAGE.test(result.stderrTail)) {
    return { failure: 'no_space', detail };
  }
  if (result.exitCode !== null && EXIT_NOT_EXECUTABLE.has(result.exitCode)) {
    return { failure: 'unavailable', detail };
  }
  if (result.exitCode === EXIT_INTERRUPTED) return { failure: 'killed', detail };
  return { failure: 'failed', detail };
}

/** Last non-empty stderr lines, single line, bounded (goes to logs and error metadata). */
function summarize(stderr: string): string {
  const lines = stderr
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const text = lines.slice(-3).join(' | ');
  if (text.length === 0) return 'no output';
  return text.length > DETAIL_MAX_LENGTH ? text.slice(text.length - DETAIL_MAX_LENGTH) : text;
}

function framesTooLarge(limit: number): MediaToolError {
  const mib = Math.round(limit / (1024 * 1024));
  return new MediaToolError('ffmpeg', 'no_space', `frames passed ${mib} MiB (MAX_FRAMES_MB)`);
}

/** {@link IVideoToolkit} adapter on top of the ffprobe/ffmpeg CLIs. */
export class FfmpegVideoToolkit implements IVideoToolkit {
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly nicePath: string;
  private readonly niceness: number | null;
  private readonly measureDir: (dir: string) => Promise<number>;
  private readonly sizePollMs: number;

  constructor(
    private readonly runner: ProcessRunner,
    options: FfmpegToolkitOptions = {},
  ) {
    this.ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
    this.ffprobePath = options.ffprobePath ?? 'ffprobe';
    this.nicePath = options.nicePath ?? 'nice';
    this.niceness = options.niceness === undefined ? 10 : options.niceness;
    this.measureDir = options.measureDir ?? directorySizeBytes;
    this.sizePollMs = options.sizePollMs ?? FRAMES_SIZE_POLL_MS;
  }

  async probe(sourcePath: string, options: MediaToolRunOptions): Promise<VideoProbe> {
    const result = await this.execute('ffprobe', this.ffprobePath, ffprobeArgs(sourcePath), {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      captureStdout: true,
    });
    return parseFfprobeOutput(result.stdout);
  }

  /**
   * Runs ffmpeg while measuring `framesDir`: past `maxTotalBytes` ffmpeg is stopped and the
   * run fails with `no_space` (as a full disk would), before the work disk fills. The folder is
   * measured once more at the end (a fast run may finish between two measurements).
   */
  async extractFrames(
    sourcePath: string,
    framesDir: string,
    options: ExtractFramesOptions,
  ): Promise<void> {
    const args = ffmpegArgs(sourcePath, framesDir, options);
    const overBudget = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, overBudget.signal])
      : overBudget.signal;
    const stopWatching = this.watchFramesSize(framesDir, options.maxTotalBytes, overBudget);
    try {
      await this.runFfmpeg(args, { timeoutMs: options.timeoutMs, signal });
    } catch (error) {
      if (overBudget.signal.aborted && !options.signal?.aborted) {
        throw framesTooLarge(options.maxTotalBytes);
      }
      throw error;
    } finally {
      stopWatching();
    }
    if ((await this.measureDir(framesDir)) > options.maxTotalBytes) {
      throw framesTooLarge(options.maxTotalBytes);
    }
  }

  private async runFfmpeg(args: string[], run: ProcessRunOptions): Promise<void> {
    if (this.niceness === null) {
      await this.execute('ffmpeg', this.ffmpegPath, args, run);
      return;
    }
    await this.execute(
      'ffmpeg',
      this.nicePath,
      ['-n', String(this.niceness), this.ffmpegPath, ...args],
      run,
    );
  }

  /** Polls the folder size; aborts `controller` once it passes `limit`. Returns the stopper. */
  private watchFramesSize(dir: string, limit: number, controller: AbortController): () => void {
    let measuring = false;
    const timer = setInterval(() => {
      if (measuring || controller.signal.aborted) return;
      measuring = true;
      this.measureDir(dir)
        .then((bytes) => {
          if (bytes > limit) controller.abort();
        })
        // A failed measurement is not a failed job: the next tick tries again.
        .catch(() => undefined)
        .finally(() => {
          measuring = false;
        });
    }, this.sizePollMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async execute(
    tool: MediaTool,
    command: string,
    args: string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    let result: ProcessRunResult;
    try {
      result = await this.runner.run(command, args, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MediaToolError(tool, 'unavailable', detail, { cause: error });
    }
    const outcome = classifyRun(result);
    if (outcome) throw new MediaToolError(tool, outcome.failure, outcome.detail);
    return result;
  }
}
