import { MediaToolError } from '../../domain/media-tool.error';
import type { ProcessRunner, ProcessRunResult } from '../process/process-runner';
import { ProcessSpawnError } from '../process/process-runner';
import { classifyRun, FfmpegVideoToolkit, ffmpegArgs, ffprobeArgs } from './ffmpeg-video-toolkit';

const OK: ProcessRunResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
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

async function failure(promise: Promise<unknown>): Promise<MediaToolError> {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MediaToolError);
  return error as MediaToolError;
}

describe('ffmpeg/ffprobe arguments', () => {
  it('ffmpeg = base project command + -nostdin, -protocol_whitelist file, -threads 2', () => {
    expect(ffmpegArgs('/work/v/source.mp4', '/work/v/frames')).toEqual([
      '-nostdin',
      '-protocol_whitelist',
      'file',
      '-i',
      '/work/v/source.mp4',
      '-vf',
      'fps=1',
      '-threads',
      '2',
      '-y',
      '/work/v/frames/frame_%04d.png',
    ]);
  });

  it('ffprobe prints container and streams as JSON, local files only', () => {
    expect(ffprobeArgs('/work/v/source.mp4')).toEqual([
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
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
      captureStdout: true,
    });
  });

  it('extractFrames runs ffmpeg under `nice -n 10` by default', async () => {
    const { runner, run } = fakeRunner();

    await new FfmpegVideoToolkit(runner).extractFrames('/w/s.mp4', '/w/frames', {
      timeoutMs: 600_000,
    });

    expect(run).toHaveBeenCalledWith(
      'nice',
      ['-n', '10', 'ffmpeg', ...ffmpegArgs('/w/s.mp4', '/w/frames')],
      { timeoutMs: 600_000 },
    );
  });

  it('accepts custom binaries and can run without nice', async () => {
    const { runner, run } = fakeRunner();
    const toolkit = new FfmpegVideoToolkit(runner, {
      ffmpegPath: '/opt/ffmpeg',
      ffprobePath: '/opt/ffprobe',
      niceness: null,
    });

    await toolkit.extractFrames('/w/s.mp4', '/w/frames', { timeoutMs: 1 });
    run.mockResolvedValueOnce({ ...OK, stdout: PROBE_JSON });
    await toolkit.probe('/w/s.mp4', { timeoutMs: 1 });

    expect(run.mock.calls.map(([command]) => command)).toEqual(['/opt/ffmpeg', '/opt/ffprobe']);
  });

  it('custom nice binary and niceness', async () => {
    const { runner, run } = fakeRunner();

    await new FfmpegVideoToolkit(runner, { nicePath: '/usr/bin/nice', niceness: 5 }).extractFrames(
      '/w/s.mp4',
      '/w/frames',
      { timeoutMs: 1 },
    );

    expect(run.mock.calls[0]?.[0]).toBe('/usr/bin/nice');
    expect(run.mock.calls[0]?.[1].slice(0, 3)).toEqual(['-n', '5', 'ffmpeg']);
  });

  it('turns a spawn failure into MediaToolError(unavailable)', async () => {
    const { runner } = fakeRunner(
      new ProcessSpawnError('nice', { cause: new Error('spawn nice ENOENT') }),
    );

    const error = await failure(
      new FfmpegVideoToolkit(runner).extractFrames('/w/s', '/w/f', { timeoutMs: 1 }),
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

  it('reports the time spent when killed by the timeout', () => {
    expect(classifyRun({ ...OK, timedOut: true, durationMs: 1234 })?.detail).toBe(
      'killed after 1234 ms',
    );
  });
});
