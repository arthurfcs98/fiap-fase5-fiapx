import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** `true` when both ffmpeg and ffprobe run from PATH. */
export function hasFfmpeg(): boolean {
  return ['ffmpeg', 'ffprobe'].every(
    (tool) => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0,
  );
}

/**
 * `describe` for tests that run the real ffmpeg. Without ffmpeg the suite is skipped locally
 * (with a clear message), but in CI (`CI=true`) it FAILS: the pipeline must install ffmpeg
 * (`sudo apt-get install -y ffmpeg` on the ubuntu runner) so these tests always run there.
 */
export function describeWithFfmpeg(name: string, suite: () => void): void {
  if (hasFfmpeg()) {
    describe(name, suite);
    return;
  }
  if (process.env['CI']) {
    describe(name, () => {
      it('requires ffmpeg and ffprobe in PATH', () => {
        throw new Error(
          'ffmpeg/ffprobe not found: the CI integration job must install them ' +
            '(sudo apt-get install -y --no-install-recommends ffmpeg) before npm run test:int',
        );
      });
    });
    return;
  }
  process.stderr.write(
    `\n[video-worker] SKIPPED "${name}": ffmpeg/ffprobe not found in PATH ` +
      '(brew install ffmpeg | apt-get install ffmpeg). In CI this suite is mandatory.\n',
  );
  describe.skip(name, suite);
}

export interface TestVideoOptions {
  durationS: number;
  /** Default: 320x240. */
  size?: string;
  /** Default: 10 fps. */
  rate?: number;
}

/** Synthetic video (`ffmpeg -f lavfi -i testsrc`), the same kind the fixtures script produces. */
export async function generateTestVideo(path: string, options: TestVideoOptions): Promise<void> {
  const source = `testsrc=duration=${options.durationS}:size=${options.size ?? '320x240'}:rate=${options.rate ?? 10}`;
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    source,
    '-pix_fmt',
    'yuv420p',
    path,
  ]);
}

/** Audio only (sine wave) in an MP4 container: no video stream. */
export async function generateAudioOnly(path: string, durationS: number): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${durationS}`,
    path,
  ]);
}

/** Valid MP4 `ftyp` box + random bytes: passes magic-bytes checks, unreadable by ffprobe. */
export async function writeCorruptMp4(path: string): Promise<void> {
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 32]),
    Buffer.from('ftypisom'),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from('isomiso2avc1mp41'),
  ]);
  await writeFile(path, Buffer.concat([ftyp, randomBytes(64 * 1024)]));
}

/**
 * MKV written to a PIPE (non-seekable output): the muxer cannot go back to write the duration,
 * so ffprobe reports none. Used to prove that the frame cap, not the header, bounds the job.
 */
export function generateStreamedMkv(path: string, durationS: number): void {
  const fd = openSync(path, 'w');
  try {
    const result = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        `testsrc=duration=${durationS}:size=64x64:rate=1`,
        '-pix_fmt',
        'yuv420p',
        '-f',
        'matroska',
        'pipe:1',
      ],
      { stdio: ['ignore', fd, 'inherit'] },
    );
    if (result.status !== 0) throw new Error(`ffmpeg failed to write ${path}`);
  } finally {
    closeSync(fd);
  }
}

/** Width and height of a PNG (IHDR, bytes 16-23). */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** PNG file signature. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
