import type { Readable } from 'node:stream';
import type { FrameFile } from '../frames';

/** Injection token of {@link IWorkDirectory}. */
export const WORK_DIRECTORY = Symbol('WORK_DIRECTORY');

/** Scratch area of one job run: `<WORK_DIR>/<videoId>/<runId>/`. */
export interface JobWorkspace {
  videoId: string;
  /** `<WORK_DIR>/<videoId>/<runId>`: removed as a whole when the run ends. */
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
   * Creates a fresh workspace for one run of the video, never shared with another run (a
   * redelivered message must not touch the files of a run that is still finishing).
   */
  prepare(videoId: string, sourceExtension: string): Promise<JobWorkspace>;
  /** Streams the raw video to `workspace.sourcePath`; resolves with the bytes written. */
  saveSource(workspace: JobWorkspace, body: Readable): Promise<number>;
  /** Frames extracted by ffmpeg, in frame order. */
  listFrames(workspace: JobWorkspace): Promise<FrameFile[]>;
  /** Removes the run workspace, and the video folder once empty (idempotent). */
  remove(workspace: JobWorkspace): Promise<void>;
  /**
   * Removes root entries older than `maxAgeMs` (leftovers of a process that died before its
   * `finally`). Resolves with the removed entry names.
   */
  sweepStale(maxAgeMs: number): Promise<string[]>;
}
