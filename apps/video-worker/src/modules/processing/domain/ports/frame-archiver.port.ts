import type { Readable } from 'node:stream';
import type { FrameFile } from '../frames';

/** Injection token of {@link IFrameArchiver}. */
export const FRAME_ARCHIVER = Symbol('FRAME_ARCHIVER');

/** Port that packs the extracted frames into a zip, as a stream (the zip never touches disk). */
export interface IFrameArchiver {
  /**
   * Streams a zip with one entry per frame (entry name = `frame.name`, no compression: PNG is
   * already compressed). The stream is destroyed with an error if a frame cannot be read;
   * destroying it from the outside aborts the archiving.
   */
  archive(frames: readonly FrameFile[]): Readable;
}
