import { join } from 'node:path';
import { FRAME_FILE_PATTERN } from '../../domain/frames';
import type { MediaTool, MediaToolFailure } from '../../domain/media-tool.error';
import { MediaToolError } from '../../domain/media-tool.error';
import type { IVideoToolkit, MediaToolRunOptions } from '../../domain/ports/video-toolkit.port';
import type { VideoProbe } from '../../domain/video-probe';
import type { ProcessRunner, ProcessRunOptions, ProcessRunResult } from '../process/process-runner';
import { parseFfprobeOutput } from './ffprobe-output.parser';

export interface FfmpegToolkitOptions {
  /** Default: `ffmpeg` (from PATH). */
  ffmpegPath?: string;
  /** Default: `ffprobe` (from PATH). */
  ffprobePath?: string;
  /** Default: `nice` (from PATH). */
  nicePath?: string;
  /** `nice -n <value>` for ffmpeg (lower CPU priority on the shared VM). `null` disables. Default: 10. */
  niceness?: number | null;
}

/**
 * ffmpeg arguments: the base project command (`-i <video> -vf fps=1 -y frame_%04d.png`) plus
 * `-nostdin` (never waits for the terminal), `-protocol_whitelist file` (a crafted input cannot
 * make ffmpeg open network URLs) and `-threads 2` (contratos.md, section 9).
 */
export function ffmpegArgs(sourcePath: string, framesDir: string): string[] {
  return [
    '-nostdin',
    '-protocol_whitelist',
    'file',
    '-i',
    sourcePath,
    '-vf',
    'fps=1',
    '-threads',
    '2',
    '-y',
    join(framesDir, FRAME_FILE_PATTERN),
  ];
}

/** ffprobe arguments: JSON with container and streams, local files only. */
export function ffprobeArgs(sourcePath: string): string[] {
  return [
    '-v',
    'error',
    '-protocol_whitelist',
    'file',
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

/** {@link IVideoToolkit} adapter on top of the ffprobe/ffmpeg CLIs. */
export class FfmpegVideoToolkit implements IVideoToolkit {
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly nicePath: string;
  private readonly niceness: number | null;

  constructor(
    private readonly runner: ProcessRunner,
    options: FfmpegToolkitOptions = {},
  ) {
    this.ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
    this.ffprobePath = options.ffprobePath ?? 'ffprobe';
    this.nicePath = options.nicePath ?? 'nice';
    this.niceness = options.niceness === undefined ? 10 : options.niceness;
  }

  async probe(sourcePath: string, options: MediaToolRunOptions): Promise<VideoProbe> {
    const result = await this.execute('ffprobe', this.ffprobePath, ffprobeArgs(sourcePath), {
      timeoutMs: options.timeoutMs,
      captureStdout: true,
    });
    return parseFfprobeOutput(result.stdout);
  }

  async extractFrames(
    sourcePath: string,
    framesDir: string,
    options: MediaToolRunOptions,
  ): Promise<void> {
    const args = ffmpegArgs(sourcePath, framesDir);
    if (this.niceness === null) {
      await this.execute('ffmpeg', this.ffmpegPath, args, { timeoutMs: options.timeoutMs });
      return;
    }
    await this.execute(
      'ffmpeg',
      this.nicePath,
      ['-n', String(this.niceness), this.ffmpegPath, ...args],
      { timeoutMs: options.timeoutMs },
    );
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
