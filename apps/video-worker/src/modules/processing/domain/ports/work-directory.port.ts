import type { Readable } from 'node:stream';
import type { FrameFile } from '../frames';

/** Injection token of {@link IWorkDirectory}. */
export const WORK_DIRECTORY = Symbol('WORK_DIRECTORY');

/** Scratch area of one job: `<WORK_DIR>/<videoId>/`. */
export interface JobWorkspace {
  videoId: string;
  /** `<WORK_DIR>/<videoId>`: removed as a whole when the job ends. */
  dir: string;
  /** Downloaded raw video (`<dir>/source.<ext>`). */
  sourcePath: string;
  /** ffmpeg output directory (`<dir>/frames`). */
  framesDir: string;
}

/** Port for the local scratch disk used by ffmpeg. */
export interface IWorkDirectory {
  /** Creates the root if needed and checks that it is writable (fail fast at boot). */
  ensureRoot(): Promise<void>;
  /**
   * Creates a clean workspace for the video. Leftovers of a previous attempt of the same video
   * (e.g. the process was killed mid-job) are removed first.
   */
  prepare(videoId: string, sourceExtension: string): Promise<JobWorkspace>;
  /** Streams the raw video to `workspace.sourcePath`; resolves with the bytes written. */
  saveSource(workspace: JobWorkspace, body: Readable): Promise<number>;
  /** Frames extracted by ffmpeg, in frame order. */
  listFrames(workspace: JobWorkspace): Promise<FrameFile[]>;
  /** Removes the workspace (idempotent). */
  remove(workspace: JobWorkspace): Promise<void>;
  /**
   * Removes root entries older than `maxAgeMs` (leftovers of a process that died before its
   * `finally`). Age-based, so jobs of other replicas sharing the volume are left alone.
   * Resolves with the removed entry names.
   */
  sweepStale(maxAgeMs: number): Promise<string[]>;
}
