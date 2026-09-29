/** Output pattern of the base project (`frame_%04d.png`, 1-based, one frame per second). */
export const FRAME_FILE_PATTERN = 'frame_%04d.png';

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
