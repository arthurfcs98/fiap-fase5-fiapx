import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { LocalWorkDirectory } from './local-work-directory';

const VIDEO_ID = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_ID = '0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b';

describe('LocalWorkDirectory', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'fiapx-work-'));
    root = join(base, 'work');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('resolves the root to an absolute path', () => {
    expect(new LocalWorkDirectory('relative/work').root).toBe(join(process.cwd(), 'relative/work'));
  });

  it('ensureRoot creates the directory tree', async () => {
    await new LocalWorkDirectory(join(root, 'nested')).ensureRoot();
    expect(existsSync(join(root, 'nested'))).toBe(true);
  });

  it('ensureRoot fails when the root cannot be created', async () => {
    writeFileSync(join(base, 'file'), 'x');
    await expect(new LocalWorkDirectory(join(base, 'file', 'work')).ensureRoot()).rejects.toThrow();
  });

  it('prepare creates <root>/<videoId>/<runId>/frames and names the source after the raw extension', async () => {
    const workDirectory = new LocalWorkDirectory(root);

    const workspace = await workDirectory.prepare(VIDEO_ID, '.MP4');

    expect(dirname(workspace.dir)).toBe(join(root, VIDEO_ID));
    expect(workspace).toEqual({
      videoId: VIDEO_ID,
      dir: workspace.dir,
      sourcePath: join(workspace.dir, 'source.mp4'),
      framesDir: join(workspace.dir, 'frames'),
    });
    expect(existsSync(workspace.framesDir)).toBe(true);
  });

  it.each([
    ['no extension', ''],
    ['weird extension', '.mp4;rm -rf'],
  ])('prepare falls back to "source" (%s)', async (_case, extension) => {
    const workspace = await new LocalWorkDirectory(root).prepare(VIDEO_ID, extension);
    expect(workspace.sourcePath).toBe(join(workspace.dir, 'source'));
  });

  it("two runs of the same video never share (or delete) each other's files", async () => {
    const workDirectory = new LocalWorkDirectory(root);
    const first = await workDirectory.prepare(VIDEO_ID, 'mp4');
    writeFileSync(join(first.framesDir, 'frame_0001.png'), 'first run');

    const second = await workDirectory.prepare(VIDEO_ID, 'mp4');

    expect(second.dir).not.toBe(first.dir);
    expect(await workDirectory.listFrames(second)).toEqual([]);
    expect(await workDirectory.listFrames(first)).toHaveLength(1);

    await workDirectory.remove(second);
    expect(existsSync(first.framesDir)).toBe(true); // the video folder stays while in use
    await workDirectory.remove(first);
    expect(existsSync(join(root, VIDEO_ID))).toBe(false);
  });

  it('prepare refuses a video id that is not a UUID (no path traversal)', async () => {
    await expect(new LocalWorkDirectory(root).prepare('../../etc', 'mp4')).rejects.toThrow(
      'not a UUID',
    );
  });

  it('saveSource streams the body to disk and returns its size', async () => {
    const workDirectory = new LocalWorkDirectory(root);
    const workspace = await workDirectory.prepare(VIDEO_ID, 'mp4');

    const size = await workDirectory.saveSource(
      workspace,
      Readable.from([Buffer.from('abc'), Buffer.from('def')]),
    );

    expect(size).toBe(6);
    expect(readFileSync(workspace.sourcePath, 'utf8')).toBe('abcdef');
  });

  it('saveSource propagates stream errors', async () => {
    const workDirectory = new LocalWorkDirectory(root);
    const workspace = await workDirectory.prepare(VIDEO_ID, 'mp4');
    const broken = new Readable({
      read() {
        this.destroy(new Error('ECONNRESET'));
      },
    });

    await expect(workDirectory.saveSource(workspace, broken)).rejects.toThrow('ECONNRESET');
  });

  it('listFrames returns only frame files in frame order', async () => {
    const workDirectory = new LocalWorkDirectory(root);
    const workspace = await workDirectory.prepare(VIDEO_ID, 'mp4');
    for (const name of ['frame_0002.png', 'frame_0010.png', 'frame_0001.png', 'other.txt']) {
      writeFileSync(join(workspace.framesDir, name), 'x');
    }

    const frames = await workDirectory.listFrames(workspace);

    expect(frames).toEqual(
      ['frame_0001.png', 'frame_0002.png', 'frame_0010.png'].map((name) => ({
        name,
        path: join(workspace.framesDir, name),
      })),
    );
  });

  it('remove deletes the whole workspace and is idempotent', async () => {
    const workDirectory = new LocalWorkDirectory(root);
    const workspace = await workDirectory.prepare(VIDEO_ID, 'mp4');

    await workDirectory.remove(workspace);
    await workDirectory.remove(workspace);

    expect(existsSync(workspace.dir)).toBe(false);
    expect(existsSync(join(root, VIDEO_ID))).toBe(false);
  });

  it('remove propagates unexpected errors on the video folder', async () => {
    const workDirectory = new LocalWorkDirectory(root);
    // A "run" whose parent is a file: rmdir fails with ENOTDIR (not an expected race).
    writeFileSync(join(base, 'file'), 'x');
    await expect(
      workDirectory.remove({
        videoId: VIDEO_ID,
        dir: join(base, 'file', 'run'),
        sourcePath: '',
        framesDir: '',
      }),
    ).rejects.toThrow(/ENOTDIR/);
  });

  describe('sweepStale', () => {
    const HOUR = 3_600_000;

    it('removes only job directories older than the limit', async () => {
      const now = Date.now();
      const workDirectory = new LocalWorkDirectory(root, () => now);
      const old = await workDirectory.prepare(VIDEO_ID, 'mp4');
      const fresh = await workDirectory.prepare(OTHER_ID, 'mp4');
      const oldTime = new Date(now - 2 * HOUR);
      utimesSync(join(root, VIDEO_ID), oldTime, oldTime);
      mkdirSync(join(root, 'lost+found'));
      utimesSync(join(root, 'lost+found'), oldTime, oldTime);

      const removed = await workDirectory.sweepStale(HOUR);

      expect(removed).toEqual([VIDEO_ID]);
      expect(existsSync(old.dir)).toBe(false);
      expect(existsSync(fresh.dir)).toBe(true);
      expect(existsSync(join(root, 'lost+found'))).toBe(true);
    });

    it('with age 0 (production: WORK_DIR is private) removes every job folder at boot', async () => {
      const workDirectory = new LocalWorkDirectory(root);
      await workDirectory.prepare(VIDEO_ID, 'mp4');
      await workDirectory.prepare(OTHER_ID, 'mp4');

      expect((await workDirectory.sweepStale(0)).sort()).toEqual([VIDEO_ID, OTHER_ID].sort());
    });

    it('is a no-op when the root does not exist yet', async () => {
      await expect(new LocalWorkDirectory(join(base, 'missing')).sweepStale(HOUR)).resolves.toEqual(
        [],
      );
    });

    it('propagates errors other than "not found" when listing the root', async () => {
      writeFileSync(join(base, 'file'), 'x');
      await expect(new LocalWorkDirectory(join(base, 'file')).sweepStale(HOUR)).rejects.toThrow(
        /ENOTDIR/,
      );
    });
  });
});
