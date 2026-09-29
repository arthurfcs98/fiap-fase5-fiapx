import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NonRetryableError } from '@fiapx/common';
import { RetryableError } from '@fiapx/common';
import type { PayloadOf } from '@fiapx/contracts';
import { RecordingEventPublisher } from '@fiapx/messaging/testing';
import { rawVideoKey, zipKey } from '@fiapx/storage';
import { InMemoryObjectStorage } from '@fiapx/storage/testing';
import { Logger } from '@nestjs/common';
import { Registry } from '@prometheus-io/client';
import type { ProcessingSettings } from '../src/modules/processing/application/processing.settings';
import { ProcessVideoUseCase } from '../src/modules/processing/application/use-cases/process-video.use-case';
import { FfmpegVideoToolkit } from '../src/modules/processing/infrastructure/ffmpeg/ffmpeg-video-toolkit';
import { LocalWorkDirectory } from '../src/modules/processing/infrastructure/filesystem/local-work-directory';
import { PrometheusProcessingMetrics } from '../src/modules/processing/infrastructure/metrics/prometheus-processing-metrics';
import { ProcessRunner } from '../src/modules/processing/infrastructure/process/process-runner';
import { ArchiverFrameArchiver } from '../src/modules/processing/infrastructure/zip/archiver-frame-archiver';
import {
  describeWithFfmpeg,
  generateAudioOnly,
  generateStreamedMkv,
  generateTestVideo,
  PNG_SIGNATURE,
  pngSize,
  writeCorruptMp4,
} from './support/media';
import { readStoredEntry, readZipEntries } from './support/zip-reader';

/**
 * Real ffprobe/ffmpeg, real scratch disk and real archiver; storage and broker are in-memory
 * doubles (the full stack with RabbitMQ and Garage is in video-worker.int-spec.ts).
 */
describeWithFfmpeg('video processing pipeline with the real ffmpeg', () => {
  let base: string;
  let videos: string;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    base = await mkdtemp(join(tmpdir(), 'fiapx-ffmpeg-int-'));
    videos = join(base, 'videos');
    await mkdir(videos);
    await Promise.all([
      generateTestVideo(join(videos, 'sample-3s.mp4'), { durationS: 3 }),
      generateTestVideo(join(videos, 'sample-10s-vga.mp4'), {
        durationS: 10,
        size: '640x480',
        rate: 25,
      }),
      generateTestVideo(join(videos, 'sample-2s-4k.mp4'), {
        durationS: 2,
        size: '3840x2160',
        rate: 2,
      }),
      generateAudioOnly(join(videos, 'audio-only.mp4'), 2),
      writeCorruptMp4(join(videos, 'corrupt.mp4')),
    ]);
    generateStreamedMkv(join(videos, 'no-duration-30s.mkv'), 30);
  });

  afterAll(async () => {
    Logger.overrideLogger(new Logger());
    await rm(base, { recursive: true, force: true });
  });

  function setup(settings: Partial<ProcessingSettings> = {}) {
    const storage = new InMemoryObjectStorage();
    const publisher = new RecordingEventPublisher();
    const runner = new ProcessRunner();
    const workRoot = join(base, `work-${randomUUID()}`);
    const useCase = new ProcessVideoUseCase(
      storage,
      publisher,
      new FfmpegVideoToolkit(runner),
      new ArchiverFrameArchiver(),
      new LocalWorkDirectory(workRoot),
      new PrometheusProcessingMetrics(new Registry()),
      {
        workerId: 'int-worker',
        ffmpegTimeoutMs: 60_000,
        ffprobeTimeoutMs: 30_000,
        maxVideoDurationS: 600,
        maxFramesBytes: 1536 * 1024 * 1024,
        staleWorkDirMs: 0,
        shutdownTimeoutMs: 120_000,
        ...settings,
      },
    );
    return { storage, publisher, runner, useCase, workRoot };
  }

  async function upload(
    storage: InMemoryObjectStorage,
    file: string,
  ): Promise<PayloadOf<'video.uploaded'>> {
    const userId = randomUUID();
    const videoId = randomUUID();
    const body = await readFile(join(videos, file));
    const video = {
      videoId,
      userId,
      originalName: file,
      rawBucket: 'fiapx-raw',
      rawKey: rawVideoKey(userId, videoId, 'mp4'),
      zipBucket: 'fiapx-zips',
      zipKey: zipKey(userId, videoId),
      sizeBytes: body.length,
    };
    await storage.putStream({ bucket: video.rawBucket, key: video.rawKey, body });
    return video;
  }

  const command = (video: PayloadOf<'video.uploaded'>, retryCount = 0) => ({
    messageId: randomUUID(),
    correlationId: `int-${video.videoId}`,
    retryCount,
    video,
  });

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => {
        throw new Error('expected the job to fail');
      },
      (error: unknown) => error,
    );
  }

  it('3 s video → 3 PNG frames in a stored zip, completed published, scratch dir removed', async () => {
    const { storage, publisher, useCase, workRoot } = setup();
    const video = await upload(storage, 'sample-3s.mp4');

    const outcome = await useCase.execute(command(video));

    expect(outcome).toMatchObject({ status: 'completed', frameCount: 3 });
    const zip = storage.contentOf(video.zipBucket, video.zipKey);
    expect(zip).toBeDefined();
    const entries = readZipEntries(zip as Buffer);
    expect(entries.map((entry) => entry.name)).toEqual([
      'frame_0001.png',
      'frame_0002.png',
      'frame_0003.png',
    ]);
    for (const entry of entries) {
      expect(entry.method).toBe(0);
      expect(readStoredEntry(zip as Buffer, entry).subarray(0, 8)).toEqual(PNG_SIGNATURE);
    }
    expect((await storage.head(video.zipBucket, video.zipKey)).metadata).toEqual({
      'video-id': video.videoId,
      'frame-count': '3',
    });
    expect(publisher.ofType('video.processing.completed')[0]?.payload).toMatchObject({
      frameCount: 3,
      zipSizeBytes: (zip as Buffer).length,
    });
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('corrupted file (valid MP4 header, random body) → P0001', async () => {
    const { storage, useCase, workRoot } = setup();
    const video = await upload(storage, 'corrupt.mp4');

    const error = await rejection(useCase.execute(command(video)));

    expect((error as NonRetryableError).appError?.code).toBe('P0001');
    expect(storage.contentOf(video.zipBucket, video.zipKey)).toBeUndefined();
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('audio-only file → P0001 (no video stream)', async () => {
    const { storage, useCase } = setup();
    const video = await upload(storage, 'audio-only.mp4');

    const error = await rejection(useCase.execute(command(video)));

    expect((error as NonRetryableError).appError?.code).toBe('P0001');
    expect((error as NonRetryableError).appError.metadata).toEqual({ detail: 'no video stream' });
  });

  it('longer than MAX_VIDEO_DURATION_S → P0003 before ffmpeg runs', async () => {
    const { storage, useCase } = setup({ maxVideoDurationS: 2 });
    const video = await upload(storage, 'sample-3s.mp4');

    const error = await rejection(useCase.execute(command(video)));

    expect((error as NonRetryableError).appError?.code).toBe('P0003');
  });

  it('container WITHOUT a duration cannot bypass MAX_VIDEO_DURATION_S: the frame cap → P0003', async () => {
    const { storage, publisher, useCase, workRoot } = setup({ maxVideoDurationS: 10 });
    const video = await upload(storage, 'no-duration-30s.mkv');

    const error = await rejection(useCase.execute(command(video)));

    expect((error as NonRetryableError).appError?.code).toBe('P0003');
    // ffmpeg stopped at 11 frames (10 s + 1 to detect the overflow), not at 30.
    expect((error as NonRetryableError).appError.metadata).toEqual({
      durationS: 11,
      maxDurationS: 10,
    });
    expect(storage.contentOf(video.zipBucket, video.zipKey)).toBeUndefined();
    expect(publisher.ofType('video.processing.completed')).toEqual([]);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('frames over MAX_FRAMES_MB: ffmpeg is stopped and the video fails with P0006 (no retry)', async () => {
    // The real disk is not filled here: a tiny budget stands in for the 2 GiB emptyDir.
    const { storage, publisher, useCase, workRoot } = setup({ maxFramesBytes: 64 * 1024 });
    const video = await upload(storage, 'sample-10s-vga.mp4');

    const error = await rejection(useCase.execute(command(video)));

    expect((error as NonRetryableError).appError?.code).toBe('P0006');
    expect(storage.contentOf(video.zipBucket, video.zipKey)).toBeUndefined();
    expect(publisher.ofType('video.processing.completed')).toEqual([]);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('4K video: frames scaled down to 1920 px on the longest side', async () => {
    const { storage, useCase } = setup();
    const video = await upload(storage, 'sample-2s-4k.mp4');

    const outcome = await useCase.execute(command(video));

    expect(outcome.frameCount).toBe(2);
    const zip = storage.contentOf(video.zipBucket, video.zipKey) as Buffer;
    const [first] = readZipEntries(zip);
    expect(pngSize(readStoredEntry(zip, first as never))).toEqual({ width: 1920, height: 1080 });
  });

  it('delivery abandoned mid-ffmpeg: ffmpeg is killed, nothing is published, the run folder is removed', async () => {
    const { storage, publisher, runner, useCase, workRoot } = setup();
    const video = await upload(storage, 'sample-10s-vga.mp4');
    const controller = new AbortController();
    const toolkit = new FfmpegVideoToolkit(runner);
    const extract = jest.spyOn(FfmpegVideoToolkit.prototype, 'extractFrames');
    // The channel closes as ffmpeg starts: the spawned process gets the aborted signal.
    extract.mockImplementationOnce((...args) => {
      controller.abort();
      extract.mockRestore();
      return toolkit.extractFrames(...args);
    });

    const error = await rejection(
      useCase.execute({ ...command(video), signal: controller.signal }),
    );

    expect(error).toBeInstanceOf(RetryableError);
    expect(publisher.ofType('video.processing.completed')).toEqual([]);
    expect(storage.contentOf(video.zipBucket, video.zipKey)).toBeUndefined();
    expect(runner.runningCount).toBe(0);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('ffmpeg over FFMPEG_TIMEOUT_MS is killed: transient on attempt 1, P0004 afterwards', async () => {
    const { storage, runner, useCase, workRoot } = setup({ ffmpegTimeoutMs: 10 });
    const video = await upload(storage, 'sample-10s-vga.mp4');

    const startedAt = Date.now();
    const first = await rejection(useCase.execute(command(video, 0)));
    expect(first).toBeInstanceOf(RetryableError);
    expect((first as RetryableError).reason).toBe('FFMPEG_TIMEOUT after 10 ms (first attempt)');
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const second = await rejection(useCase.execute(command(video, 1)));
    expect((second as NonRetryableError).appError?.code).toBe('P0004');

    expect(runner.runningCount).toBe(0);
    expect(await readdir(workRoot)).toEqual([]);
  });
});
