import { Readable } from 'node:stream';
import { NonRetryableError, RetryableError } from '@fiapx/common';
import { videoUploadedFixture } from '@fiapx/contracts/fixtures';
import { PublishError } from '@fiapx/messaging';
import { RecordingEventPublisher } from '@fiapx/messaging/testing';
import { StorageQuotaExceededError } from '@fiapx/storage';
import { InMemoryObjectStorage } from '@fiapx/storage/testing';
import { Logger } from '@nestjs/common';
import type { FrameFile } from '../../domain/frames';
import { MediaToolError } from '../../domain/media-tool.error';
import type { IFrameArchiver } from '../../domain/ports/frame-archiver.port';
import type { IProcessingMetrics, JobResult } from '../../domain/ports/processing-metrics.port';
import type {
  ExtractFramesOptions,
  IVideoToolkit,
  MediaToolRunOptions,
} from '../../domain/ports/video-toolkit.port';
import type { IWorkDirectory, JobWorkspace } from '../../domain/ports/work-directory.port';
import type { VideoProbe } from '../../domain/video-probe';
import { workerEventId } from '../event-ids';
import type { ProcessingSettings } from '../processing.settings';
import type { ProcessVideoCommand } from './process-video.use-case';
import { ProcessVideoUseCase, ZIP_CONTENT_TYPE } from './process-video.use-case';

const VIDEO = videoUploadedFixture.payload;
const RAW_BYTES = Buffer.from('raw video bytes');
const SETTINGS: ProcessingSettings = {
  workerId: 'worker-test-1',
  ffmpegTimeoutMs: 600_000,
  ffprobeTimeoutMs: 30_000,
  maxVideoDurationS: 600,
  maxFramesBytes: 1536 * 1024 * 1024,
  staleWorkDirMs: 0,
  shutdownTimeoutMs: 690_000,
};

/** In-memory scratch disk: records what the use case does with it. */
class FakeWorkDirectory implements IWorkDirectory {
  readonly prepared: JobWorkspace[] = [];
  readonly removed: string[] = [];
  readonly sources = new Map<string, Buffer>();
  readonly frames = new Map<string, FrameFile[]>();
  prepareError?: Error;
  saveError?: Error;
  removeError?: Error;

  ensureRoot(): Promise<void> {
    return Promise.resolve();
  }

  prepare(videoId: string, sourceExtension: string): Promise<JobWorkspace> {
    if (this.prepareError) return Promise.reject(this.prepareError);
    const dir = `/work/${videoId}`;
    const workspace = {
      videoId,
      dir,
      sourcePath: `${dir}/source${sourceExtension}`,
      framesDir: `${dir}/frames`,
    };
    this.prepared.push(workspace);
    return Promise.resolve(workspace);
  }

  async saveSource(workspace: JobWorkspace, body: Readable): Promise<number> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    if (this.saveError) throw this.saveError;
    const content = Buffer.concat(chunks);
    this.sources.set(workspace.sourcePath, content);
    return content.length;
  }

  addFrames(framesDir: string, count: number): void {
    this.frames.set(
      framesDir,
      Array.from({ length: count }, (_, i) => {
        const name = `frame_${String(i + 1).padStart(4, '0')}.png`;
        return { name, path: `${framesDir}/${name}` };
      }),
    );
  }

  listFrames(workspace: JobWorkspace): Promise<FrameFile[]> {
    return Promise.resolve(this.frames.get(workspace.framesDir) ?? []);
  }

  remove(workspace: JobWorkspace): Promise<void> {
    if (this.removeError) return Promise.reject(this.removeError);
    this.removed.push(workspace.dir);
    return Promise.resolve();
  }

  sweepStale(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

/** ffprobe/ffmpeg double: "extracts" `frameCount` frames into the fake work directory. */
class FakeToolkit implements IVideoToolkit {
  probeResult: VideoProbe = {
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationSeconds: 3,
    videoStreamCount: 1,
  };
  probeError?: Error;
  extractError?: Error;
  frameCount = 3;
  /** Runs inside extractFrames (e.g. to abort the delivery mid-job). */
  onExtract?: () => void;
  readonly calls: { tool: 'probe' | 'extract'; path: string; options: MediaToolRunOptions }[] = [];

  constructor(private readonly workDirectory: FakeWorkDirectory) {}

  probe(sourcePath: string, options: MediaToolRunOptions): Promise<VideoProbe> {
    this.calls.push({ tool: 'probe', path: sourcePath, options });
    return this.probeError ? Promise.reject(this.probeError) : Promise.resolve(this.probeResult);
  }

  extractFrames(sourcePath: string, framesDir: string, options: ExtractFramesOptions) {
    this.calls.push({ tool: 'extract', path: sourcePath, options });
    this.onExtract?.();
    if (this.extractError) return Promise.reject(this.extractError);
    this.workDirectory.addFrames(framesDir, this.frameCount);
    return Promise.resolve();
  }
}

/** "Zip" = the frame names, one per line (the real archiver has its own tests). */
class FakeArchiver implements IFrameArchiver {
  readonly streams: Readable[] = [];

  archive(frames: readonly FrameFile[]): Readable {
    const stream = Readable.from([Buffer.from(frames.map((f) => f.name).join('\n'))]);
    this.streams.push(stream);
    return stream;
  }
}

class RecordingMetrics implements IProcessingMetrics {
  started = 0;
  readonly finished: { result: JobResult; durationSeconds: number }[] = [];

  jobStarted(): void {
    this.started += 1;
  }

  jobFinished(result: JobResult, durationSeconds: number): void {
    this.finished.push({ result, durationSeconds });
  }
}

function setup() {
  const storage = new InMemoryObjectStorage();
  const publisher = new RecordingEventPublisher();
  const workDirectory = new FakeWorkDirectory();
  const toolkit = new FakeToolkit(workDirectory);
  const archiver = new FakeArchiver();
  const metrics = new RecordingMetrics();
  const useCase = new ProcessVideoUseCase(
    storage,
    publisher,
    toolkit,
    archiver,
    workDirectory,
    metrics,
    SETTINGS,
  );
  return { storage, publisher, workDirectory, toolkit, archiver, metrics, useCase };
}

type Setup = ReturnType<typeof setup>;

async function withRawVideo(context: Setup): Promise<Setup> {
  await context.storage.putStream({ bucket: VIDEO.rawBucket, key: VIDEO.rawKey, body: RAW_BYTES });
  return context;
}

function command(overrides: Partial<ProcessVideoCommand> = {}): ProcessVideoCommand {
  return {
    messageId: videoUploadedFixture.id,
    correlationId: videoUploadedFixture.correlationId,
    retryCount: 0,
    video: VIDEO,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

function appCode(error: unknown): string {
  expect(error).toBeInstanceOf(NonRetryableError);
  return (error as NonRetryableError).appError.code;
}

function retryReason(error: unknown): string {
  expect(error).toBeInstanceOf(RetryableError);
  return (error as RetryableError).reason;
}

describe('ProcessVideoUseCase', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterAll(() => {
    Logger.overrideLogger(new Logger());
  });

  describe('happy path', () => {
    it('publishes started, extracts, uploads the zip with metadata and publishes completed', async () => {
      const context = await withRawVideo(setup());
      const { storage, publisher, workDirectory, toolkit, metrics, useCase } = context;

      const outcome = await useCase.execute(command());

      expect(outcome).toMatchObject({ status: 'completed', frameCount: 3 });
      expect(publisher.events.map((e) => e.type)).toEqual([
        'video.processing.started',
        'video.processing.completed',
      ]);
      const [started] = publisher.ofType('video.processing.started');
      expect(started).toMatchObject({
        id: workerEventId(videoUploadedFixture.id, 'video.processing.started', 1),
        correlationId: videoUploadedFixture.correlationId,
        payload: { videoId: VIDEO.videoId, attempt: 1, workerId: 'worker-test-1' },
      });

      const zip = storage.contentOf(VIDEO.zipBucket, VIDEO.zipKey);
      expect(zip?.toString()).toBe('frame_0001.png\nframe_0002.png\nframe_0003.png');
      const head = await storage.head(VIDEO.zipBucket, VIDEO.zipKey);
      expect(head.contentType).toBe(ZIP_CONTENT_TYPE);
      expect(head.metadata).toEqual({ 'video-id': VIDEO.videoId, 'frame-count': '3' });

      const [completed] = publisher.ofType('video.processing.completed');
      expect(completed).toMatchObject({
        id: workerEventId(videoUploadedFixture.id, 'video.processing.completed'),
        correlationId: videoUploadedFixture.correlationId,
        payload: {
          videoId: VIDEO.videoId,
          zipKey: VIDEO.zipKey,
          frameCount: 3,
          zipSizeBytes: zip?.length,
          durationMs: outcome.durationMs,
        },
      });

      const workspace = workDirectory.prepared[0];
      expect(workspace?.sourcePath).toBe(`/work/${VIDEO.videoId}/source.mp4`);
      expect(workDirectory.sources.get(workspace?.sourcePath ?? '')).toEqual(RAW_BYTES);
      expect(toolkit.calls).toEqual([
        {
          tool: 'probe',
          path: workspace?.sourcePath,
          options: { timeoutMs: 30_000, signal: undefined },
        },
        {
          tool: 'extract',
          path: workspace?.sourcePath,
          // At most one frame per second of MAX_VIDEO_DURATION_S (+1 to detect longer videos).
          options: {
            timeoutMs: 600_000,
            signal: undefined,
            frameLimit: 601,
            maxDimension: 1920,
            maxTotalBytes: 1536 * 1024 * 1024,
          },
        },
      ]);
      expect(workDirectory.removed).toEqual([`/work/${VIDEO.videoId}`]);
      expect(metrics.started).toBe(1);
      expect(metrics.finished).toEqual([
        { result: 'completed', durationSeconds: expect.any(Number) },
      ]);
    });

    it('reports attempt = x-retry-count + 1', async () => {
      const { publisher, useCase } = await withRawVideo(setup());

      await useCase.execute(command({ retryCount: 2 }));

      const [started] = publisher.ofType('video.processing.started');
      expect(started?.payload.attempt).toBe(3);
      expect(started?.id).toBe(
        workerEventId(videoUploadedFixture.id, 'video.processing.started', 3),
      );
    });
  });

  describe('idempotency (HEAD of the zip)', () => {
    it('zip with valid metadata → republishes completed without running ffmpeg', async () => {
      const { storage, publisher, toolkit, workDirectory, metrics, useCase } = setup();
      await storage.putStream({
        bucket: VIDEO.zipBucket,
        key: VIDEO.zipKey,
        body: Buffer.from('zip-bytes'),
        metadata: { 'video-id': VIDEO.videoId, 'frame-count': '7' },
      });

      const outcome = await useCase.execute(command({ retryCount: 1 }));

      expect(outcome).toMatchObject({ status: 'duplicate', frameCount: 7, zipSizeBytes: 9 });
      expect(publisher.events.map((e) => e.type)).toEqual(['video.processing.completed']);
      expect(publisher.ofType('video.processing.completed')[0]).toMatchObject({
        id: workerEventId(videoUploadedFixture.id, 'video.processing.completed'),
        payload: { frameCount: 7, zipSizeBytes: 9, zipKey: VIDEO.zipKey },
      });
      expect(toolkit.calls).toEqual([]);
      expect(workDirectory.prepared).toEqual([]);
      expect(metrics.finished[0]?.result).toBe('duplicate');
    });

    it.each([
      ['without frame-count', { 'video-id': VIDEO.videoId }],
      ['with a non-numeric frame-count', { 'video-id': VIDEO.videoId, 'frame-count': 'x' }],
      ['with frame-count 0', { 'video-id': VIDEO.videoId, 'frame-count': '0' }],
      ['of another video', { 'video-id': videoUploadedFixture.id, 'frame-count': '3' }],
    ])('zip %s → processes again and overwrites it', async (_case, metadata) => {
      const { storage, publisher, useCase } = await withRawVideo(setup());
      await storage.putStream({
        bucket: VIDEO.zipBucket,
        key: VIDEO.zipKey,
        body: Buffer.from('old'),
        metadata,
      });

      const outcome = await useCase.execute(command());

      expect(outcome.status).toBe('completed');
      expect(publisher.ofType('video.processing.started')).toHaveLength(1);
      expect((await storage.head(VIDEO.zipBucket, VIDEO.zipKey)).metadata['frame-count']).toBe('3');
    });

    it('empty zip object → processes again', async () => {
      const { storage, useCase } = await withRawVideo(setup());
      await storage.putStream({
        bucket: VIDEO.zipBucket,
        key: VIDEO.zipKey,
        body: Buffer.alloc(0),
        metadata: { 'video-id': VIDEO.videoId, 'frame-count': '3' },
      });

      await expect(useCase.execute(command())).resolves.toMatchObject({ status: 'completed' });
    });

    it('storage failure on HEAD → transient, nothing published', async () => {
      const { storage, publisher, metrics, useCase } = setup();
      storage.failNext('head');

      const error = await rejection(useCase.execute(command()));

      expect(retryReason(error)).toMatch(/^STORAGE_UNAVAILABLE: /);
      expect(publisher.events).toEqual([]);
      expect(metrics.finished[0]?.result).toBe('retry');
    });
  });

  describe('source video', () => {
    it('raw video missing → P0005 after started, work directory removed', async () => {
      const { publisher, workDirectory, toolkit, metrics, useCase } = setup();

      const error = await rejection(useCase.execute(command()));

      expect(appCode(error)).toBe('P0005');
      expect(publisher.events.map((e) => e.type)).toEqual(['video.processing.started']);
      expect(toolkit.calls).toEqual([]);
      expect(workDirectory.removed).toHaveLength(1);
      expect(metrics.finished[0]?.result).toBe('failed');
    });

    it('storage failure on GET → transient', async () => {
      const context = await withRawVideo(setup());
      context.storage.failNext('get');

      const error = await rejection(context.useCase.execute(command()));

      expect(retryReason(error)).toMatch(/^STORAGE_UNAVAILABLE: /);
      expect(context.workDirectory.removed).toHaveLength(1);
    });

    it('download interrupted / disk error → transient', async () => {
      const context = await withRawVideo(setup());
      context.workDirectory.saveError = new Error('ECONNRESET');

      const error = await rejection(context.useCase.execute(command()));

      expect(retryReason(error)).toBe('SOURCE_DOWNLOAD_FAILED: Error: ECONNRESET');
    });

    it('work directory unavailable → transient', async () => {
      const context = await withRawVideo(setup());
      context.workDirectory.prepareError = new Error('EACCES');

      const error = await rejection(context.useCase.execute(command()));

      expect(retryReason(error)).toBe('WORK_DIR_UNAVAILABLE: Error: EACCES');
    });
  });

  describe('ffprobe', () => {
    it.each([
      ['unsupported container', { formatName: 'hls' }, 'P0001'],
      ['no video stream', { videoStreamCount: 0 }, 'P0001'],
      ['longer than MAX_VIDEO_DURATION_S', { durationSeconds: 601 }, 'P0003'],
    ])('%s → %s, ffmpeg never runs', async (_case, probe, expected) => {
      const context = await withRawVideo(setup());
      context.toolkit.probeResult = { ...context.toolkit.probeResult, ...probe };

      const error = await rejection(context.useCase.execute(command()));

      expect(appCode(error)).toBe(expected);
      expect(context.toolkit.calls.map((c) => c.tool)).toEqual(['probe']);
      expect(context.workDirectory.removed).toHaveLength(1);
    });

    it('P0003 carries the duration and the limit', async () => {
      const context = await withRawVideo(setup());
      context.toolkit.probeResult = { ...context.toolkit.probeResult, durationSeconds: 900 };

      const error = await rejection(context.useCase.execute(command()));

      expect((error as NonRetryableError).appError.metadata).toEqual({
        durationS: 900,
        maxDurationS: 600,
      });
    });

    it('corrupted file (ffprobe exit code) → P0001', async () => {
      const context = await withRawVideo(setup());
      context.toolkit.probeError = new MediaToolError('ffprobe', 'failed', 'exit code 1: moov');

      expect(appCode(await rejection(context.useCase.execute(command())))).toBe('P0001');
    });

    it('ffprobe timeout: transient on the first attempt, P0004 on later ones', async () => {
      const first = await withRawVideo(setup());
      first.toolkit.probeError = new MediaToolError('ffprobe', 'timeout', 'killed');
      expect(retryReason(await rejection(first.useCase.execute(command())))).toBe(
        'FFPROBE_TIMEOUT after 30000 ms (first attempt)',
      );

      const later = await withRawVideo(setup());
      later.toolkit.probeError = new MediaToolError('ffprobe', 'timeout', 'killed');
      const error = await rejection(later.useCase.execute(command({ retryCount: 1 })));
      expect(appCode(error)).toBe('P0004');
    });
  });

  describe('ffmpeg', () => {
    it('timeout on the first attempt → transient', async () => {
      const context = await withRawVideo(setup());
      context.toolkit.extractError = new MediaToolError('ffmpeg', 'timeout', 'killed');

      const error = await rejection(context.useCase.execute(command()));

      expect(retryReason(error)).toBe('FFMPEG_TIMEOUT after 600000 ms (first attempt)');
      expect(context.metrics.finished[0]?.result).toBe('retry');
      expect(context.workDirectory.removed).toHaveLength(1);
    });

    it('timeout on a retry → P0004 with FFMPEG_TIMEOUT_MS', async () => {
      const context = await withRawVideo(setup());
      context.toolkit.extractError = new MediaToolError('ffmpeg', 'timeout', 'killed');

      const error = await rejection(context.useCase.execute(command({ retryCount: 2 })));

      expect(appCode(error)).toBe('P0004');
      expect((error as NonRetryableError).appError.metadata).toEqual({ timeoutMs: 600_000 });
    });

    it('killed by the OOM killer → transient', async () => {
      const context = await withRawVideo(setup());
      context.toolkit.extractError = new MediaToolError(
        'ffmpeg',
        'killed',
        'terminated by SIGKILL',
      );

      expect(retryReason(await rejection(context.useCase.execute(command())))).toBe(
        'FFMPEG_KILLED: terminated by SIGKILL',
      );
    });

    it('decoder error (exit code) → P0001', async () => {
      const context = await withRawVideo(setup());
      context.toolkit.extractError = new MediaToolError('ffmpeg', 'failed', 'exit code 183');

      expect(appCode(await rejection(context.useCase.execute(command())))).toBe('P0001');
    });

    it('no frame extracted → P0002', async () => {
      const context = await withRawVideo(setup());
      context.toolkit.frameCount = 0;

      const error = await rejection(context.useCase.execute(command()));

      expect(appCode(error)).toBe('P0002');
      expect(context.storage.contentOf(VIDEO.zipBucket, VIDEO.zipKey)).toBeUndefined();
    });

    it('disk full while extracting → P0006, no retries (the frames of this video do not fit)', async () => {
      const context = await withRawVideo(setup());
      context.toolkit.extractError = new MediaToolError('ffmpeg', 'no_space', 'exit code 228');

      const error = await rejection(context.useCase.execute(command()));

      expect(appCode(error)).toBe('P0006');
      expect(context.workDirectory.removed).toHaveLength(1);
    });

    it('more frames than MAX_VIDEO_DURATION_S allows (no duration in the header) → P0003', async () => {
      const context = await withRawVideo(setup());
      context.toolkit.probeResult = { ...context.toolkit.probeResult, durationSeconds: undefined };
      context.toolkit.frameCount = 601;

      const error = await rejection(context.useCase.execute(command()));

      expect(appCode(error)).toBe('P0003');
      expect((error as NonRetryableError).appError.metadata).toEqual({
        durationS: 601,
        maxDurationS: 600,
      });
      expect(context.storage.contentOf(VIDEO.zipBucket, VIDEO.zipKey)).toBeUndefined();
    });

    it('exactly MAX_VIDEO_DURATION_S frames is accepted', async () => {
      const context = await withRawVideo(setup());
      context.toolkit.frameCount = 600;

      await expect(context.useCase.execute(command())).resolves.toMatchObject({
        status: 'completed',
        frameCount: 600,
      });
    });

    it('unexpected error from the toolkit → transient', async () => {
      const context = await withRawVideo(setup());
      context.toolkit.extractError = new TypeError('bug');

      expect(retryReason(await rejection(context.useCase.execute(command())))).toBe(
        'UNEXPECTED: TypeError: bug',
      );
    });
  });

  describe('zip upload and publishing', () => {
    it('upload failure → transient, archive stream destroyed, nothing completed', async () => {
      const context = await withRawVideo(setup());
      context.storage.failNext('put');

      const error = await rejection(context.useCase.execute(command()));

      expect(retryReason(error)).toMatch(/^ZIP_UPLOAD_FAILED: ObjectStorageError: /);
      expect(context.archiver.streams[0]?.destroyed).toBe(true);
      expect(context.publisher.ofType('video.processing.completed')).toEqual([]);
      expect(context.workDirectory.removed).toHaveLength(1);
    });

    it('zip bucket full (quota) → P0007 right away, no retries', async () => {
      const context = await withRawVideo(setup());
      context.storage.failNext(
        'put',
        new StorageQuotaExceededError('put', VIDEO.zipBucket, VIDEO.zipKey),
      );

      const error = await rejection(context.useCase.execute(command()));

      expect(appCode(error)).toBe('P0007');
      expect(context.publisher.ofType('video.processing.completed')).toEqual([]);
      expect(context.metrics.finished[0]?.result).toBe('failed');
    });

    it('started not confirmed → transient before touching the disk', async () => {
      const context = await withRawVideo(setup());
      context.publisher.failNextWith(new PublishError('fiapx.events', 'video.processing.started'));

      const error = await rejection(context.useCase.execute(command()));

      expect(retryReason(error)).toMatch(/^PUBLISH_FAILED \(video\.processing\.started\): /);
      expect(context.workDirectory.prepared).toEqual([]);
    });

    it('completed not confirmed → transient; the retry finds the zip and republishes', async () => {
      const context = await withRawVideo(setup());
      // started goes through, completed is not confirmed.
      const failing = new PublishError('fiapx.events', 'video.processing.completed');
      const publishEvent = context.publisher.publishEvent.bind(context.publisher);
      jest
        .spyOn(context.publisher, 'publishEvent')
        .mockImplementation((event, options) =>
          event.type === 'video.processing.completed'
            ? Promise.reject(failing)
            : publishEvent(event, options),
        );

      const error = await rejection(context.useCase.execute(command()));
      expect(retryReason(error)).toMatch(/^PUBLISH_FAILED \(video\.processing\.completed\): /);
      expect(context.storage.contentOf(VIDEO.zipBucket, VIDEO.zipKey)).toBeDefined();

      jest.restoreAllMocks();
      const retry = await context.useCase.execute(command({ retryCount: 1 }));
      expect(retry.status).toBe('duplicate');
      expect(context.publisher.ofType('video.processing.completed')).toHaveLength(1);
    });

    it('cleanup failure does not change the outcome', async () => {
      const context = await withRawVideo(setup());
      context.workDirectory.removeError = new Error('EBUSY');

      await expect(context.useCase.execute(command())).resolves.toMatchObject({
        status: 'completed',
      });
    });
  });

  describe('delivery abandoned (AMQP channel closed)', () => {
    it('already aborted: publishes nothing and touches nothing', async () => {
      const context = await withRawVideo(setup());
      const controller = new AbortController();
      controller.abort();

      await rejection(context.useCase.execute(command({ signal: controller.signal })));

      expect(context.publisher.events).toEqual([]);
      expect(context.workDirectory.prepared).toEqual([]);
      expect(context.metrics.finished[0]?.result).toBe('retry');
    });

    it('aborted while ffmpeg runs: the tools get the signal, no zip and no completed', async () => {
      const context = await withRawVideo(setup());
      const controller = new AbortController();
      context.toolkit.onExtract = () => controller.abort();

      await rejection(context.useCase.execute(command({ signal: controller.signal })));

      expect(context.toolkit.calls.every((call) => call.options.signal === controller.signal)).toBe(
        true,
      );
      expect(context.storage.contentOf(VIDEO.zipBucket, VIDEO.zipKey)).toBeUndefined();
      expect(context.publisher.ofType('video.processing.completed')).toEqual([]);
      expect(context.workDirectory.removed).toHaveLength(1);
    });

    it('aborted during the download: the source stream is destroyed', async () => {
      const context = await withRawVideo(setup());
      const controller = new AbortController();
      const saveSource = context.workDirectory.saveSource.bind(context.workDirectory);
      jest
        .spyOn(context.workDirectory, 'saveSource')
        .mockImplementation(async (workspace, body) => {
          controller.abort();
          return saveSource(workspace, body);
        });

      const error = await rejection(
        context.useCase.execute(command({ signal: controller.signal })),
      );

      expect(error).toBeInstanceOf(RetryableError);
      expect(context.toolkit.calls).toEqual([]);
    });
  });

  it('keeps the in-flight gauge balanced on every path', async () => {
    const ok = await withRawVideo(setup());
    await ok.useCase.execute(command());
    const failed = setup();
    await rejection(failed.useCase.execute(command()));

    for (const { metrics } of [ok, failed]) {
      expect(metrics.started).toBe(1);
      expect(metrics.finished).toHaveLength(1);
    }
  });
});
