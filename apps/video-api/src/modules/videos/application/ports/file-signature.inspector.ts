import type { Readable } from 'node:stream';

export interface DetectedContainer {
  /** Container as named by `file-type` (`mp4`, `mov`, `mkv`, `asf`...). */
  container: string;
  mime: string;
}

export interface InspectedStream {
  /** `undefined` when the first bytes match no known format. */
  detected?: DetectedContainer;
  /** The same bytes, from the start (the inspected head is replayed). */
  stream: Readable;
}

/** Magic-bytes check on the first chunk of an upload, without buffering the whole file. */
export interface FileSignatureInspector {
  inspect(stream: Readable): Promise<InspectedStream>;
}

export const FILE_SIGNATURE_INSPECTOR = Symbol('FILE_SIGNATURE_INSPECTOR');
