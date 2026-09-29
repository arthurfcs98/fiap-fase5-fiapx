import { performance } from 'node:perf_hooks';
import { posix } from 'node:path';
import { NonRetryableError, ProcessingErrors, RetryableError } from '@fiapx/common';
import type { FiapxEvent, PayloadOf } from '@fiapx/contracts';
import { createEvent } from '@fiapx/contracts';
import type { EventPublisher } from '@fiapx/messaging';
import { EVENT_PUBLISHER } from '@fiapx/messaging';
import type { IObjectStorage, ObjectMetadata, ObjectStream } from '@fiapx/storage';
import { OBJECT_STORAGE, ObjectNotFoundError } from '@fiapx/storage';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FrameFile } from '../../domain/frames';
import { MediaToolError } from '../../domain/media-tool.error';
import type { IFrameArchiver } from '../../domain/ports/frame-archiver.port';
import { FRAME_ARCHIVER } from '../../domain/ports/frame-archiver.port';
import type { IProcessingMetrics, JobResult } from '../../domain/ports/processing-metrics.port';
import { PROCESSING_METRICS } from '../../domain/ports/processing-metrics.port';
import type { IVideoToolkit } from '../../domain/ports/video-toolkit.port';
import { VIDEO_TOOLKIT } from '../../domain/ports/video-toolkit.port';
import type { IWorkDirectory, JobWorkspace } from '../../domain/ports/work-directory.port';
import { WORK_DIRECTORY } from '../../domain/ports/work-directory.port';
import type { VideoProbe } from '../../domain/video-probe';
import { evaluateProbe } from '../../domain/video-probe';
import { workerEventId } from '../event-ids';
import { classifyMediaToolError, toProcessingFailure } from '../failure-classifier';
import type { ProcessingSettings } from '../processing.settings';
import { PROCESSING_SETTINGS } from '../processing.settings';

export interface ProcessVideoCommand {
  /** AMQP `messageId` of the `video.uploaded` delivery (stable across retries). */
  messageId: string;
  correlationId: string;
  /** `x-retry-count` (0 on the first attempt). */
  retryCount: number;
  video: PayloadOf<'video.uploaded'>;
}

export type ProcessVideoOutcome = {
  /** `duplicate`: the zip already existed and `completed` was republished (ffmpeg skipped). */
  status: 'completed' | 'duplicate';
  frameCount: number;
  zipSizeBytes: number;
  durationMs: number;
};

/** Zip object metadata (`x-amz-meta-*`, contratos.md section 7). */
export const ZIP_METADATA = { videoId: 'video-id', frameCount: 'frame-count' } as const;
export const ZIP_CONTENT_TYPE = 'application/zip';

/**
 * Worker pipeline for one `video.uploaded` message (contratos.md, section 9):
 * 1. envelope already validated by the consumer runner;
 * 2. HEAD of the deterministic zip key: it exists → republish `completed` (idempotency);
 * 3. publish `started`; 4. download the raw video to `<WORK_DIR>/<videoId>/`;
 * 5. ffprobe (timeout, supported container, video stream, `MAX_VIDEO_DURATION_S`);
 * 6. ffmpeg `fps=1` → `frame_%04d.png` (niced, killed at `FFMPEG_TIMEOUT_MS`);
 * 7. streaming zip (store) → multipart upload with `video-id`/`frame-count` metadata;
 * 8. publish `completed` (publisher confirm), then the runner acks;
 * 9. `finally`: remove `<WORK_DIR>/<videoId>`.
 *
 * Errors leave as {@link RetryableError} (transient: `.retry.N`, then DLX → P0099) or
 * {@link NonRetryableError} (P0001/P0002/P0003/P0004/P0005: the consumer publishes
 * `video.processing.failed` and acks). Every publish waits for the broker confirm.
 */
@Injectable()
export class ProcessVideoUseCase {
  private readonly logger = new Logger(ProcessVideoUseCase.name);

  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(VIDEO_TOOLKIT) private readonly toolkit: IVideoToolkit,
    @Inject(FRAME_ARCHIVER) private readonly archiver: IFrameArchiver,
    @Inject(WORK_DIRECTORY) private readonly workDirectory: IWorkDirectory,
    @Inject(PROCESSING_METRICS) private readonly metrics: IProcessingMetrics,
    @Inject(PROCESSING_SETTINGS) private readonly settings: ProcessingSettings,
  ) {}

  async execute(command: ProcessVideoCommand): Promise<ProcessVideoOutcome> {
    const startedAt = performance.now();
    const log = { videoId: command.video.videoId, attempt: command.retryCount + 1 };
    let result: JobResult = 'retry';
    this.metrics.jobStarted();
    try {
      const outcome = await this.process(command, startedAt);
      result = outcome.status;
      this.logger.log({ msg: `Video processed (${outcome.status})`, ...log, ...outcome });
      return outcome;
    } catch (error) {
      const failure = toProcessingFailure(error);
      if (failure instanceof NonRetryableError) {
        result = 'failed';
        this.logger.warn({
          msg: `Video rejected (${failure.appError.code})`,
          ...log,
          error: failure.message,
          metadata: failure.appError.metadata,
        });
      } else {
        this.logger.warn({ msg: 'Transient processing failure', ...log, error: failure.message });
      }
      throw failure;
    } finally {
      this.metrics.jobFinished(result, (performance.now() - startedAt) / 1000);
    }
  }

  private async process(
    command: ProcessVideoCommand,
    startedAt: number,
  ): Promise<ProcessVideoOutcome> {
    const { video } = command;
    const attempt = command.retryCount + 1;

    const existing = await this.findExistingZip(video);
    if (existing) {
      const durationMs = elapsedMs(startedAt);
      await this.publishCompleted(command, existing.frameCount, existing.zipSizeBytes, durationMs);
      return { status: 'duplicate', ...existing, durationMs };
    }

    await this.publish(
      createEvent(
        'video.processing.started',
        { videoId: video.videoId, attempt, workerId: this.settings.workerId },
        command.correlationId,
        { id: workerEventId(command.messageId, 'video.processing.started', attempt) },
      ),
    );

    const workspace = await this.prepareWorkspace(video);
    try {
      await this.download(video, workspace);
      await this.probe(workspace, command.retryCount);
      await this.extractFrames(workspace, command.retryCount);
      const frames = await this.workDirectory.listFrames(workspace);
      if (frames.length === 0) throw ProcessingErrors.NO_FRAMES();
      const zipSizeBytes = await this.uploadZip(video, frames);
      const durationMs = elapsedMs(startedAt);
      await this.publishCompleted(command, frames.length, zipSizeBytes, durationMs);
      return { status: 'completed', frameCount: frames.length, zipSizeBytes, durationMs };
    } finally {
      await this.cleanUp(workspace);
    }
  }

  /** Step 2: a zip with valid metadata means a previous attempt already finished the work. */
  private async findExistingZip(
    video: PayloadOf<'video.uploaded'>,
  ): Promise<{ frameCount: number; zipSizeBytes: number } | undefined> {
    let head: ObjectMetadata;
    try {
      head = await this.storage.head(video.zipBucket, video.zipKey);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return undefined;
      throw error;
    }
    const frameCount = Number(head.metadata[ZIP_METADATA.frameCount]);
    const valid =
      head.metadata[ZIP_METADATA.videoId] === video.videoId &&
      Number.isInteger(frameCount) &&
      frameCount > 0 &&
      head.sizeBytes > 0;
    if (!valid) {
      this.logger.warn({
        msg: 'Existing zip has no valid metadata; processing again and overwriting it',
        videoId: video.videoId,
        zipKey: video.zipKey,
      });
      return undefined;
    }
    return { frameCount, zipSizeBytes: head.sizeBytes };
  }

  private async prepareWorkspace(video: PayloadOf<'video.uploaded'>): Promise<JobWorkspace> {
    try {
      return await this.workDirectory.prepare(video.videoId, posix.extname(video.rawKey));
    } catch (error) {
      throw new RetryableError(`WORK_DIR_UNAVAILABLE: ${describe(error)}`, { cause: error });
    }
  }

  /** Step 4: missing raw video is permanent (P0005); anything else is transient. */
  private async download(
    video: PayloadOf<'video.uploaded'>,
    workspace: JobWorkspace,
  ): Promise<void> {
    let source: ObjectStream;
    try {
      source = await this.storage.getStream(video.rawBucket, video.rawKey);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw ProcessingErrors.SOURCE_NOT_FOUND();
      throw error;
    }
    try {
      await this.workDirectory.saveSource(workspace, source.body);
    } catch (error) {
      throw new RetryableError(`SOURCE_DOWNLOAD_FAILED: ${describe(error)}`, { cause: error });
    }
  }

  /** Step 5. */
  private async probe(workspace: JobWorkspace, retryCount: number): Promise<void> {
    const timeoutMs = this.settings.ffprobeTimeoutMs;
    let probe: VideoProbe;
    try {
      probe = await this.toolkit.probe(workspace.sourcePath, { timeoutMs });
    } catch (error) {
      throw this.mediaFailure(error, retryCount, timeoutMs);
    }
    const verdict = evaluateProbe(probe, this.settings.maxVideoDurationS);
    if (verdict.accepted) return;
    if (verdict.reason === 'too_long') {
      throw ProcessingErrors.VIDEO_TOO_LONG(verdict.durationSeconds, verdict.maxDurationSeconds);
    }
    throw ProcessingErrors.INVALID_VIDEO(verdict.detail);
  }

  /** Step 6. */
  private async extractFrames(workspace: JobWorkspace, retryCount: number): Promise<void> {
    const timeoutMs = this.settings.ffmpegTimeoutMs;
    try {
      await this.toolkit.extractFrames(workspace.sourcePath, workspace.framesDir, { timeoutMs });
    } catch (error) {
      throw this.mediaFailure(error, retryCount, timeoutMs);
    }
  }

  /** Step 7: resolves with the zip size counted while uploading. */
  private async uploadZip(
    video: PayloadOf<'video.uploaded'>,
    frames: readonly FrameFile[],
  ): Promise<number> {
    const body = this.archiver.archive(frames);
    try {
      const { sizeBytes } = await this.storage.putStream({
        bucket: video.zipBucket,
        key: video.zipKey,
        body,
        contentType: ZIP_CONTENT_TYPE,
        metadata: {
          [ZIP_METADATA.videoId]: video.videoId,
          [ZIP_METADATA.frameCount]: String(frames.length),
        },
      });
      return sizeBytes;
    } catch (error) {
      throw new RetryableError(`ZIP_UPLOAD_FAILED: ${describe(error)}`, { cause: error });
    } finally {
      // Upload failed half-way: stop archiving (no-op when the stream already ended).
      body.destroy();
    }
  }

  private publishCompleted(
    command: ProcessVideoCommand,
    frameCount: number,
    zipSizeBytes: number,
    durationMs: number,
  ): Promise<void> {
    return this.publish(
      createEvent(
        'video.processing.completed',
        {
          videoId: command.video.videoId,
          zipKey: command.video.zipKey,
          frameCount,
          zipSizeBytes,
          durationMs,
        },
        command.correlationId,
        { id: workerEventId(command.messageId, 'video.processing.completed') },
      ),
    );
  }

  /** Publisher confirm failures are transient: the retry finds the zip and republishes. */
  private async publish(event: FiapxEvent): Promise<void> {
    try {
      await this.publisher.publishEvent(event);
    } catch (error) {
      throw new RetryableError(`PUBLISH_FAILED (${event.type}): ${describe(error)}`, {
        cause: error,
      });
    }
  }

  private mediaFailure(error: unknown, retryCount: number, timeoutMs: number): unknown {
    return error instanceof MediaToolError
      ? classifyMediaToolError(error, { retryCount, timeoutMs })
      : error;
  }

  /** Step 9: never masks the job outcome; the startup sweep catches what is left behind. */
  private async cleanUp(workspace: JobWorkspace): Promise<void> {
    try {
      await this.workDirectory.remove(workspace);
    } catch (error) {
      this.logger.warn({
        msg: 'Could not remove the work directory; the startup sweep will',
        videoId: workspace.videoId,
        dir: workspace.dir,
        error: describe(error),
      });
    }
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
