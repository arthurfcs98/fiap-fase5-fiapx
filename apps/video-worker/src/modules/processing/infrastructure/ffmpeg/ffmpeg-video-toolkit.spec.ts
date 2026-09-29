import { MediaToolError } from '../../domain/media-tool.error';
import type { ProcessRunner, ProcessRunResult } from '../process/process-runner';
import { ProcessSpawnError } from '../process/process-runner';
import {
  classifyRun,
  FfmpegVideoToolkit,
  ffmpegArgs,
  ffprobeArgs,
  FORMAT_WHITELIST,
} from './ffmpeg-video-toolkit';

const OK: ProcessRunResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  stdout: '',
  stderrTail: '',
  durationMs: 10,
};

const PROBE_JSON = JSON.stringify({
  streams: [{ codec_type: 'video', duration: '3.0' }],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.000000' },
});

function fakeRunner(result: Partial<ProcessRunResult> | Error = {}) {
  const run = jest.fn((_command: string, _args: readonly string[]) =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve({ ...OK, ...result }),
  );
  return { runner: { run } as unknown as ProcessRunner, run };
}

const LIMITS = { frameLimit: 601, maxDimension: 1920, maxTotalBytes: 1024 * 1024 };

async function failure(promise: Promise<unknown>): Promise<MediaToolError> {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MediaToolError);
  return error as MediaToolError;
}

describe('ffmpeg/ffprobe arguments', () => {
  it('ffmpeg = base project command + hardening + output bounds (frames and size)', () => {
    expect(ffmpegArgs('/work/v/source.mp4', '/work/v/frames', LIMITS)).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      FORMAT_WHITELIST,
      '-i',
      '/work/v/source.mp4',
      '-vf',
      "fps=1,scale=w='min(iw,1920)':h='min(ih,1920)':force_original_aspect_ratio=decrease",
      '-frames:v',
      '601',
      '-threads',
      '2',
      '-y',
      '/work/v/frames/frame_%04d.png',
    ]);
  });

  it('whitelists only the demuxers of the accepted upload containers', () => {
    expect(FORMAT_WHITELIST.split(',')).toEqual([
      'mov',
      'mp4',
      'm4a',
      '3gp',
      '3g2',
      'mj2',
      'matroska',
      'webm',
      'avi',
      'asf',
      'flv',
    ]);
  });

  it('ffprobe prints container and streams as JSON, local files and whitelisted demuxers', () => {
    expect(ffprobeArgs('/work/v/source.mp4')).toEqual([
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      FORMAT_WHITELIST,
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '/work/v/source.mp4',
    ]);
  });
});

describe('FfmpegVideoToolkit', () => {
  it('probe runs ffprobe with the timeout, captures stdout and parses it', async () => {
    const { runner, run } = fakeRunner({ stdout: PROBE_JSON });

    const probe = await new FfmpegVideoToolkit(runner).probe('/w/source.mp4', {
      timeoutMs: 30_000,
    });

    expect(probe).toEqual({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 3,
      videoStreamCount: 1,
    });
    expect(run).toHaveBeenCalledWith('ffprobe', ffprobeArgs('/w/source.mp4'), {
      timeoutMs: 30_000,
      signal: undefined,
      captureStdout: true,
    });
  });

  it('extractFrames runs ffmpeg under `nice -n 10` by default, passing the abort signal', async () => {
    const { runner, run } = fakeRunner();
    const caller = new AbortController();

    await new FfmpegVideoToolkit(runner).extractFrames('/w/s.mp4', '/w/frames', {
      timeoutMs: 600_000,
      signal: caller.signal,
      ...LIMITS,
    });

    expect(run).toHaveBeenCalledWith(
      'nice',
      ['-n', '10', 'ffmpeg', ...ffmpegArgs('/w/s.mp4', '/w/frames', LIMITS)],
      { timeoutMs: 600_000, signal: expect.any(AbortSignal) },
    );
    // The signal given to the process follows the caller's (channel closed → ffmpeg killed).
    const passed = (run.mock.calls[0] as unknown as [string, string[], { signal: AbortSignal }])[2]
      .signal;
    expect(passed.aborted).toBe(false);
    caller.abort();
    expect(passed.aborted).toBe(true);
  });

  it('accepts custom binaries and can run without nice', async () => {
    const { runner, run } = fakeRunner();
    const toolkit = new FfmpegVideoToolkit(runner, {
      ffmpegPath: '/opt/ffmpeg',
      ffprobePath: '/opt/ffprobe',
      niceness: null,
    });

    await toolkit.extractFrames('/w/s.mp4', '/w/frames', { timeoutMs: 1, ...LIMITS });
    run.mockResolvedValueOnce({ ...OK, stdout: PROBE_JSON });
    await toolkit.probe('/w/s.mp4', { timeoutMs: 1 });

    expect(run.mock.calls.map(([command]) => command)).toEqual(['/opt/ffmpeg', '/opt/ffprobe']);
  });

  it('custom nice binary and niceness', async () => {
    const { runner, run } = fakeRunner();

    await new FfmpegVideoToolkit(runner, { nicePath: '/usr/bin/nice', niceness: 5 }).extractFrames(
      '/w/s.mp4',
      '/w/frames',
      { timeoutMs: 1, ...LIMITS },
    );

    expect(run.mock.calls[0]?.[0]).toBe('/usr/bin/nice');
    expect(run.mock.calls[0]?.[1].slice(0, 3)).toEqual(['-n', '5', 'ffmpeg']);
  });

  describe('frames byte budget (MAX_FRAMES_MB)', () => {
    /** A runner whose ffmpeg "runs" until its signal aborts (then reports `aborted`). */
    function runningUntilAborted() {
      const run = jest.fn(
        (_command: string, _args: readonly string[], options: { signal?: AbortSignal }) =>
          new Promise<ProcessRunResult>((resolve) => {
            options.signal?.addEventListener('abort', () =>
              resolve({ ...OK, exitCode: null, aborted: true }),
            );
          }),
      );
      return { runner: { run } as unknown as ProcessRunner, run };
    }

    it('stops ffmpeg once the frames pass the budget and fails with no_space', async () => {
      const { runner } = runningUntilAborted();
      let written = 0;
      const measureDir = jest.fn(() => Promise.resolve((written += 400 * 1024)));
      const toolkit = new FfmpegVideoToolkit(runner, { measureDir, sizePollMs: 2 });

      const error = await failure(
        toolkit.extractFrames('/w/s.mp4', '/w/frames', { timeoutMs: 60_000, ...LIMITS }),
      );

      expect(error).toMatchObject({
        tool: 'ffmpeg',
        failure: 'no_space',
        detail: 'frames passed 1 MiB (MAX_FRAMES_MB)',
      });
      expect(measureDir).toHaveBeenCalledWith('/w/frames');
      expect(measureDir).toHaveBeenCalledTimes(3); // 400 KiB, 800 KiB, 1200 KiB > 1 MiB
    });

    it('a delivery abandoned by the caller stays `aborted`, not `no_space`', async () => {
      const { runner } = runningUntilAborted();
      const caller = new AbortController();
      const measureDir = jest.fn(() => Promise.resolve(0));
      const toolkit = new FfmpegVideoToolkit(runner, { measureDir, sizePollMs: 60_000 });

      const pending = toolkit.extractFrames('/w/s.mp4', '/w/frames', {
        timeoutMs: 60_000,
        signal: caller.signal,
        ...LIMITS,
      });
      caller.abort();

      expect(await failure(pending)).toMatchObject({ tool: 'ffmpeg', failure: 'aborted' });
    });

    it('measures once more at the end: a fast run over the budget still fails', async () => {
      const { runner } = fakeRunner();
      const measureDir = jest.fn(() => Promise.resolve(LIMITS.maxTotalBytes + 1));
      const toolkit = new FfmpegVideoToolkit(runner, { measureDir, sizePollMs: 60_000 });

      const error = await failure(
        toolkit.extractFrames('/w/s.mp4', '/w/frames', { timeoutMs: 1, ...LIMITS }),
      );

      expect(error).toMatchObject({ failure: 'no_space' });
      expect(measureDir).toHaveBeenCalledTimes(1);
    });

    it('a failed measurement is retried on the next tick, one measurement at a time', async () => {
      const { runner, run } = runningUntilAborted();
      let release: (bytes: number) => void = () => undefined;
      const measureDir = jest
        .fn<Promise<number>, [string]>()
        .mockRejectedValueOnce(new Error('EIO'))
        .mockImplementationOnce(() => new Promise<number>((resolve) => (release = resolve)))
        .mockResolvedValue(LIMITS.maxTotalBytes + 1);
      const toolkit = new FfmpegVideoToolkit(runner, { measureDir, sizePollMs: 2 });

      const pending = toolkit.extractFrames('/w/s.mp4', '/w/frames', {
        timeoutMs: 60_000,
        ...LIMITS,
      });
      const deadline = Date.now() + 5_000;
      while (measureDir.mock.calls.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      // 1st tick failed, 2nd is still measuring: the ticks in between did not start another.
      expect(measureDir).toHaveBeenCalledTimes(2);
      release(0);

      expect(await failure(pending)).toMatchObject({ failure: 'no_space' });
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('stops measuring when ffmpeg ends', async () => {
      const { runner } = fakeRunner();
      const measureDir = jest.fn(() => Promise.resolve(0));
      const toolkit = new FfmpegVideoToolkit(runner, { measureDir, sizePollMs: 1 });

      await toolkit.extractFrames('/w/s.mp4', '/w/frames', { timeoutMs: 1, ...LIMITS });
      const calls = measureDir.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(measureDir.mock.calls.length).toBe(calls);
    });
  });

  it('turns a spawn failure into MediaToolError(unavailable)', async () => {
    const { runner } = fakeRunner(
      new ProcessSpawnError('nice', { cause: new Error('spawn nice ENOENT') }),
    );

    const error = await failure(
      new FfmpegVideoToolkit(runner).extractFrames('/w/s', '/w/f', { timeoutMs: 1, ...LIMITS }),
    );

    expect(error).toMatchObject({ tool: 'ffmpeg', failure: 'unavailable' });
    expect(error.detail).toContain('ENOENT');
  });

  it('describes non-Error runner failures', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error on purpose
    const run = jest.fn(() => Promise.reject('boom'));
    const toolkit = new FfmpegVideoToolkit({ run } as unknown as ProcessRunner);

    const error = await failure(toolkit.probe('/w/s', { timeoutMs: 1 }));

    expect(error).toMatchObject({ tool: 'ffprobe', failure: 'unavailable', detail: 'boom' });
  });

  it('turns a non-zero exit into MediaToolError with the stderr tail', async () => {
    const { runner } = fakeRunner({
      exitCode: 1,
      stderrTail: '[mov @ 0x1] moov atom not found\nsource.mp4: Invalid data found\n',
    });

    const error = await failure(new FfmpegVideoToolkit(runner).probe('/w/s', { timeoutMs: 1 }));

    expect(error).toMatchObject({
      tool: 'ffprobe',
      failure: 'failed',
      detail: 'exit code 1: [mov @ 0x1] moov atom not found | source.mp4: Invalid data found',
    });
  });
});

describe('classifyRun', () => {
  it.each<[string, Partial<ProcessRunResult>, string | undefined]>([
    ['exit 0', {}, undefined],
    ['our timeout', { timedOut: true, signal: 'SIGKILL', exitCode: null }, 'timeout'],
    ['cancelled by the caller', { aborted: true, signal: 'SIGKILL', exitCode: null }, 'aborted'],
    ['external SIGKILL (OOM)', { signal: 'SIGKILL', exitCode: null }, 'killed'],
    ['interrupted (exit 255)', { exitCode: 255 }, 'killed'],
    ['ENOSPC exit status (228)', { exitCode: 228 }, 'no_space'],
    ['ENOSPC in stderr', { exitCode: 1, stderrTail: 'No space left on device' }, 'no_space'],
    ['nice: not found (127)', { exitCode: 127 }, 'unavailable'],
    ['nice: not executable (126)', { exitCode: 126 }, 'unavailable'],
    ['invalid data (183)', { exitCode: 183 }, 'failed'],
    ['generic error (1)', { exitCode: 1 }, 'failed'],
  ])('%s → %s', (_case, result, expected) => {
    expect(classifyRun({ ...OK, ...result })?.failure).toBe(expected);
  });

  it('keeps the detail short: last three stderr lines, at most 300 characters', () => {
    const outcome = classifyRun({
      ...OK,
      exitCode: 1,
      stderrTail: `a\nb\r\nc\rd\n\n${'x'.repeat(400)}`,
    });
    expect(outcome?.detail.startsWith('exit code 1: ')).toBe(true);
    expect(outcome?.detail.length).toBe('exit code 1: '.length + 300);

    expect(classifyRun({ ...OK, exitCode: 1, stderrTail: 'a\nb\nc\nd' })?.detail).toBe(
      'exit code 1: b | c | d',
    );
    expect(classifyRun({ ...OK, exitCode: 1 })?.detail).toBe('exit code 1: no output');
  });

  it('reports the time spent when killed by the timeout or cancelled', () => {
    expect(classifyRun({ ...OK, timedOut: true, durationMs: 1234 })?.detail).toBe(
      'killed after 1234 ms',
    );
    expect(classifyRun({ ...OK, aborted: true, durationMs: 50 })?.detail).toBe(
      'cancelled after 50 ms',
    );
  });
});
