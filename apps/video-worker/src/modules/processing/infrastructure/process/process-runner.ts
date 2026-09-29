import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';

export interface ProcessRunOptions {
  /** The process is SIGKILLed (AbortController) when it runs longer than this. */
  timeoutMs: number;
  /** Keep stdout (ffprobe JSON). Default: discarded. */
  captureStdout?: boolean;
  /** stdout cap when captured. Default: 1 MiB (anything beyond is dropped). */
  maxStdoutBytes?: number;
}

export interface ProcessRunResult {
  /** `null` when the process was terminated by a signal. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Our time budget expired and the process was killed. */
  timedOut: boolean;
  stdout: string;
  /** Last bytes of stderr (diagnostics). */
  stderrTail: string;
  durationMs: number;
}

/** The binary could not be started (ENOENT, EACCES...). */
export class ProcessSpawnError extends Error {
  constructor(
    public readonly command: string,
    options: { cause: unknown },
  ) {
    const reason = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`could not start "${command}": ${reason}`, options);
    this.name = 'ProcessSpawnError';
  }
}

const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

/**
 * Runs external processes (ffprobe/ffmpeg) without a shell, with a hard time budget: an
 * `AbortController` fires after `timeoutMs` and Node kills the child with SIGKILL. Never
 * rejects because of the exit code; the caller interprets {@link ProcessRunResult}.
 *
 * On application shutdown, processes still running (the consumer already waited for the
 * in-flight job) are killed so no ffmpeg outlives the worker.
 */
@Injectable()
export class ProcessRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(ProcessRunner.name);
  private readonly running = new Set<ChildProcess>();

  /** Child processes currently running. */
  get runningCount(): number {
    return this.running.size;
  }

  /** @throws ProcessSpawnError when the binary cannot be started. */
  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const stdout = new BoundedBuffer(options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES);
    const stderr = new TailBuffer(STDERR_TAIL_BYTES);

    return new Promise<ProcessRunResult>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', options.captureStdout ? 'pipe' : 'ignore', 'pipe'],
        signal: controller.signal,
        killSignal: 'SIGKILL',
      });
      this.running.add(child);
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      let settled = false;
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(child);
        finish();
      };

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        // Abort (our timeout): Node already sent SIGKILL and 'close' follows with the signal.
        if (controller.signal.aborted) return;
        settle(() => reject(new ProcessSpawnError(command, { cause: error })));
      });
      child.on('close', (exitCode, signal) => {
        settle(() =>
          resolve({
            exitCode,
            signal,
            // A process that exited on its own right as the timer fired was not killed by it.
            timedOut: controller.signal.aborted && signal !== null,
            stdout: stdout.toString(),
            stderrTail: stderr.toString(),
            durationMs: Date.now() - startedAt,
          }),
        );
      });
    });
  }

  /** Kills (SIGKILL) every child still running. Returns how many were signalled. */
  killAll(): number {
    let killed = 0;
    for (const child of this.running) {
      if (child.kill('SIGKILL')) killed += 1;
    }
    return killed;
  }

  onApplicationShutdown(): void {
    const killed = this.killAll();
    if (killed > 0) {
      this.logger.warn(`${killed} media process(es) killed at shutdown; the broker redelivers`);
    }
  }
}

/** Keeps the first `limit` bytes. */
class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (room <= 0) return;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** Keeps the last `limit` bytes. */
class TailBuffer {
  private buffer = Buffer.alloc(0);

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const joined = Buffer.concat([this.buffer, chunk]);
    this.buffer = joined.length > this.limit ? joined.subarray(joined.length - this.limit) : joined;
  }

  toString(): string {
    return this.buffer.toString('utf8');
  }
}
