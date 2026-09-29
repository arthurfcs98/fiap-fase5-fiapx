import { Readable } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import type {
  FileSignatureInspector,
  InspectedStream,
} from '../../application/ports/file-signature.inspector';

/** Bytes `file-type` needs to recognize every container it supports. */
export const SIGNATURE_BYTES = 4100;

/**
 * Magic-bytes detection with `file-type` on the first ~4 KB of the upload. The head is read from
 * the stream and replayed in front of the rest, so the whole file still goes to the storage in
 * streaming (nothing else is buffered).
 */
export class FileTypeSignatureInspector implements FileSignatureInspector {
  async inspect(stream: Readable): Promise<InspectedStream> {
    const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    while (length < SIGNATURE_BYTES) {
      const next = await iterator.next();
      if (next.done) {
        done = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      chunks.push(chunk);
      length += chunk.length;
    }
    const head = Buffer.concat(chunks);
    const type = head.length > 0 ? await fileTypeFromBuffer(head) : undefined;
    return {
      detected: type ? { container: type.ext, mime: type.mime } : undefined,
      stream: Readable.from(replay(head, done ? undefined : iterator)),
    };
  }
}

async function* replay(
  head: Buffer,
  rest: AsyncIterator<Buffer> | undefined,
): AsyncGenerator<Buffer> {
  if (head.length > 0) yield head;
  if (!rest) return;
  for (;;) {
    const next = await rest.next();
    if (next.done) return;
    yield next.value;
  }
}
