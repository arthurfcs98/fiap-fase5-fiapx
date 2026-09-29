/** Output pattern of the base project (`frame_%04d.png`, 1-based, one frame per second). */
export const FRAME_FILE_PATTERN = 'frame_%04d.png';

/**
 * Bounds of the frame output, so one video can never fill the worker disk or the zip bucket
 * (contratos.md, section 9):
 * - at most one frame per second of the longest accepted video (`MAX_VIDEO_DURATION_S`), even
 *   when the container does not declare a duration (the ffprobe check cannot see those);
 * - frames scaled down to 1920 px on the longest side (1080p and smaller stay as they are; a
 *   4K frame would be ~4x the bytes of a 1080p one).
 */
export const FRAME_OUTPUT_LIMITS = {
  maxDimension: 1920,
} as const;

/**
 * Most frames a video may produce: fps=1 rounds to the nearest second (a 600.4 s video gives
 * 600 frames), so one more than this means the video is longer than `maxDurationSeconds`.
 */
export function maxFramesFor(maxDurationSeconds: number): number {
  return Math.max(1, Math.round(maxDurationSeconds));
}

/** Names produced by {@link FRAME_FILE_PATTERN} (5+ digits past frame 9999). */
const FRAME_FILE_NAME = /^frame_(\d{4,})\.png$/;

/** An extracted frame on disk. `name` is the zip entry name (like the base project). */
export interface FrameFile {
  name: string;
  path: string;
}

export function isFrameFileName(name: string): boolean {
  return FRAME_FILE_NAME.test(name);
}

/** Frame index of a {@link FRAME_FILE_PATTERN} name, or `undefined` for any other name. */
export function frameIndex(name: string): number | undefined {
  const match = FRAME_FILE_NAME.exec(name);
  return match ? Number(match[1]) : undefined;
}

/**
 * Keeps only frame files and orders them by frame number (numeric, so `frame_10000.png` comes
 * after `frame_9999.png`, which a plain string sort would get wrong).
 */
export function sortFrames(frames: readonly FrameFile[]): FrameFile[] {
  return frames
    .map((frame) => ({ frame, index: frameIndex(frame.name) }))
    .filter((entry): entry is { frame: FrameFile; index: number } => entry.index !== undefined)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.frame);
}
