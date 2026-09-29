import { Readable } from 'node:stream';
import { aviBytes, mp4Bytes, pngBytes, textBytes } from '../../../../../test/support/media';
import { FileTypeSignatureInspector, SIGNATURE_BYTES } from './file-type-signature.inspector';

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Emits the buffer in small chunks, like a network stream. */
function chunked(buffer: Buffer, size = 512): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < buffer.length; i += size) parts.push(buffer.subarray(i, i + size));
  return Readable.from(parts);
}

describe('FileTypeSignatureInspector', () => {
  const inspector = new FileTypeSignatureInspector();

  it('detects the container from the head and replays every byte', async () => {
    const bytes = mp4Bytes(3 * SIGNATURE_BYTES);
    const { detected, stream } = await inspector.inspect(chunked(bytes));
    expect(detected).toEqual({ container: 'mp4', mime: 'video/mp4' });
    expect((await read(stream)).equals(bytes)).toBe(true);
  });

  it('works for files smaller than the signature window', async () => {
    const bytes = aviBytes(100);
    const { detected, stream } = await inspector.inspect(Readable.from([bytes]));
    expect(detected?.container).toBe('avi');
    expect(await read(stream)).toEqual(bytes);
  });

  it('reports other formats and unknown content', async () => {
    await expect(inspector.inspect(Readable.from([pngBytes()]))).resolves.toMatchObject({
      detected: { container: 'png' },
    });
    await expect(inspector.inspect(Readable.from([textBytes()]))).resolves.toMatchObject({
      detected: undefined,
    });
    const empty = await inspector.inspect(Readable.from([]));
    expect(empty.detected).toBeUndefined();
    expect(await read(empty.stream)).toHaveLength(0);
  });

  it('accepts string chunks and propagates source errors', async () => {
    const { stream } = await inspector.inspect(Readable.from(['abc'], { objectMode: true }));
    expect((await read(stream)).toString()).toBe('abc');

    const failing = new Readable({
      read() {
        this.push(mp4Bytes(SIGNATURE_BYTES));
        this.destroy(new Error('client gone'));
      },
    });
    const inspected = await inspector.inspect(failing).catch((error: unknown) => error);
    if (inspected instanceof Error) {
      expect(inspected.message).toBe('client gone');
    } else {
      await expect(read((inspected as { stream: Readable }).stream)).rejects.toThrow('client gone');
    }
  });
});
