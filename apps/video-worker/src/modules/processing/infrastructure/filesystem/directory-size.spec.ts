import type * as FsPromises from 'node:fs/promises';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return { ...actual, stat: jest.fn(actual.stat), readdir: jest.fn(actual.readdir) };
});

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directorySizeBytes } from './directory-size';

const mockedStat = stat as jest.MockedFunction<typeof stat>;
const mockedReaddir = readdir as jest.MockedFunction<typeof readdir>;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('directorySizeBytes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fiapx-size-'));
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('sums the regular files of the folder, ignoring subfolders', async () => {
    await writeFile(join(dir, 'frame_0001.png'), Buffer.alloc(1000));
    await writeFile(join(dir, 'frame_0002.png'), Buffer.alloc(24));
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'nested', 'ignored.png'), Buffer.alloc(5000));

    await expect(directorySizeBytes(dir)).resolves.toBe(1024);
  });

  it('a folder that does not exist (yet) counts as 0', async () => {
    await expect(directorySizeBytes(join(dir, 'frames'))).resolves.toBe(0);
  });

  it('skips a file removed between the listing and its stat', async () => {
    await writeFile(join(dir, 'frame_0001.png'), Buffer.alloc(10));
    await writeFile(join(dir, 'frame_0002.png'), Buffer.alloc(20));
    mockedStat.mockRejectedValueOnce(errno('ENOENT'));

    await expect(directorySizeBytes(dir)).resolves.toBe(20);
  });

  it('propagates other stat and listing errors', async () => {
    await writeFile(join(dir, 'frame_0001.png'), Buffer.alloc(10));
    mockedStat.mockRejectedValueOnce(errno('EIO'));
    await expect(directorySizeBytes(dir)).rejects.toThrow('EIO');

    mockedReaddir.mockRejectedValueOnce(errno('EACCES'));
    await expect(directorySizeBytes(dir)).rejects.toThrow('EACCES');
  });
});
