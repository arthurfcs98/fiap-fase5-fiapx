import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import archiver from 'archiver';
import type { FrameFile } from '../../domain/frames';
import type { IFrameArchiver } from '../../domain/ports/frame-archiver.port';

/**
 * {@link IFrameArchiver} with `archiver` in STORE mode (PNG is already compressed, so deflate
 * would only burn CPU; the base project used deflate). The zip is produced as a stream straight
 * into the upload, so it never touches the disk.
 *
 * Any archiving problem, including the `warning` archiver emits for a missing file (it would
 * silently skip the entry), destroys the returned stream with that error, which makes the upload
 * fail instead of storing an incomplete zip. Destroying the returned stream aborts archiving.
 */
export class ArchiverFrameArchiver implements IFrameArchiver {
  archive(frames: readonly FrameFile[]): Readable {
    // statConcurrency 1: archiver stats files in parallel (4 by default) and queues each entry
    // when ITS stat resolves, so entries could land out of order (frame_0003 before frame_0002).
    const zip = archiver('zip', { store: true, statConcurrency: 1 });
    const output = new PassThrough();
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      zip.abort();
      output.destroy(error);
    };
    zip.on('warning', fail);
    zip.on('error', fail);
    output.on('close', () => {
      // Consumer gave up (e.g. upload failed): stop reading frames.
      if (!settled) {
        settled = true;
        zip.abort();
      }
    });
    output.on('end', () => {
      settled = true;
    });

    zip.pipe(output);
    for (const frame of frames) {
      zip.file(frame.path, { name: frame.name });
    }
    // Every rejection of finalize() is also emitted as 'error' (already handled by `fail`).
    zip.finalize().then(undefined, fail);
    return output;
  }
}
