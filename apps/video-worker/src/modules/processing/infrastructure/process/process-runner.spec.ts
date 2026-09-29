import { Logger } from '@nestjs/common';
import { ProcessRunner, ProcessSpawnError } from './process-runner';

/** Real child processes: `node -e <script>` behaves the same on macOS and Linux. */
const NODE = process.execPath;
const script = (code: string) => ['-e', code];

describe('ProcessRunner', () => {
  let runner: ProcessRunner;

  beforeEach(() => {
    runner = new ProcessRunner();
  });

  it('captures stdout (when asked) and reports a clean exit', async () => {
    const result = await runner.run(NODE, script('process.stdout.write(\'{"ok":true}\')'), {
      timeoutMs: 10_000,
      captureStdout: true,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: '{"ok":true}',
      stderrTail: '',
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('discards stdout by default and keeps stderr and the exit code', async () => {
    const result = await runner.run(
      NODE,
      script(
        "process.stdout.write('x'); process.stderr.write('moov atom not found\\n'); process.exit(3)",
      ),
      { timeoutMs: 10_000 },
    );

    expect(result).toMatchObject({ exitCode: 3, stdout: '', stderrTail: 'moov atom not found\n' });
  });

  it('caps stdout and keeps only the tail of stderr', async () => {
    const result = await runner.run(
      NODE,
      script(
        "process.stdout.write('a'.repeat(100)); process.stderr.write('b'.repeat(6000) + 'END')",
      ),
      { timeoutMs: 10_000, captureStdout: true, maxStdoutBytes: 10 },
    );

    expect(result.stdout).toBe('a'.repeat(10));
    expect(result.stderrTail).toHaveLength(4096);
    expect(result.stderrTail.endsWith('END')).toBe(true);
  });

  it('kills the process with SIGKILL when the time budget expires (AbortController)', async () => {
    const result = await runner.run(NODE, script('setTimeout(() => {}, 30000)'), {
      timeoutMs: 200,
    });

    expect(result).toMatchObject({
      timedOut: true,
      aborted: false,
      signal: 'SIGKILL',
      exitCode: null,
    });
    expect(runner.runningCount).toBe(0);
  });

  it('kills the process when the caller aborts (delivery abandoned): aborted, not timedOut', async () => {
    const controller = new AbortController();
    const running = runner.run(NODE, script('setTimeout(() => {}, 30000)'), {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    const result = await running;

    expect(result).toMatchObject({
      aborted: true,
      timedOut: false,
      signal: 'SIGKILL',
      exitCode: null,
    });
    expect(runner.runningCount).toBe(0);
  });

  it('an already aborted caller signal kills the process right away', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runner.run(NODE, script('setTimeout(() => {}, 30000)'), {
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ aborted: true, signal: 'SIGKILL' });
  });

  it('reports a signal it did not send (e.g. OOM killer) without timedOut', async () => {
    const result = await runner.run(NODE, script("process.kill(process.pid, 'SIGTERM')"), {
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({ timedOut: false, signal: 'SIGTERM', exitCode: null });
  });

  it('rejects with ProcessSpawnError when the binary does not exist', async () => {
    const error: unknown = await runner
      .run('fiapx-binary-that-does-not-exist', [], { timeoutMs: 1_000 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProcessSpawnError);
    expect((error as ProcessSpawnError).command).toBe('fiapx-binary-that-does-not-exist');
    expect((error as Error).message).toMatch(/ENOENT/);
    expect(runner.runningCount).toBe(0);
  });

  it('describes non-Error spawn causes', () => {
    expect(new ProcessSpawnError('ffmpeg', { cause: 'EACCES' }).message).toBe(
      'could not start "ffmpeg": EACCES',
    );
  });

  it('kills processes still running at application shutdown', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const running = runner.run(NODE, script('setTimeout(() => {}, 30000)'), { timeoutMs: 30_000 });
    expect(runner.runningCount).toBe(1);

    runner.onApplicationShutdown();

    await expect(running).resolves.toMatchObject({ signal: 'SIGKILL', timedOut: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 media process(es) killed'));
  });

  it('shutdown with nothing running is silent', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    runner.onApplicationShutdown();

    expect(runner.killAll()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
