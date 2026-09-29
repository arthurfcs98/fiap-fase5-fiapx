import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { readStoredEntry, readZipEntries } from '../../../../../test/support/zip-reader';
import type { FrameFile } from '../../domain/frames';
import { ArchiverFrameArchiver } from './archiver-frame-archiver';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('ArchiverFrameArchiver', () => {
  let dir: string;
  let frames: FrameFile[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fiapx-zip-'));
    frames = [1, 2, 3].map((index) => {
      const name = `frame_000${index}.png`;
      const path = join(dir, name);
      writeFileSync(path, Buffer.from(`png-bytes-${index}`));
      return { name, path };
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams a zip with one STORE entry per frame, in order, named after the frame', async () => {
    const zip = await collect(new ArchiverFrameArchiver().archive(frames));

    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'frame_0001.png',
      'frame_0002.png',
      'frame_0003.png',
    ]);
    expect(entries.every((e) => e.method === 0)).toBe(true);
    expect(entries.map((e) => readStoredEntry(zip, e).toString())).toEqual([
      'png-bytes-1',
      'png-bytes-2',
      'png-bytes-3',
    ]);
  });

  it('fails the stream when a frame cannot be read (instead of skipping it)', async () => {
    const missing = [...frames, { name: 'frame_0004.png', path: join(dir, 'gone.png') }];

    await expect(collect(new ArchiverFrameArchiver().archive(missing))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('stops archiving when the consumer destroys the stream', async () => {
    const stream = new ArchiverFrameArchiver().archive(frames);

    stream.destroy();

    await expect(finished(stream)).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' });
    expect(stream.destroyed).toBe(true);
  });
});
