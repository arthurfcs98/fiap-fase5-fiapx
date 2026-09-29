import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { EventOf, PayloadOf, ProcessingEvent } from '@fiapx/contracts';
import { createEvent, processingEvent } from '@fiapx/contracts';
import type { EventPublisher } from '@fiapx/messaging';
import { EVENT_PUBLISHER, MessageConsumers, QUEUES, TopologyInitializer } from '@fiapx/messaging';
import { MetricsServerService } from '@fiapx/observability';
import type { IObjectStorage } from '@fiapx/storage';
import { createS3Client, rawVideoKey, S3ObjectStorage, zipKey } from '@fiapx/storage';
import type { StartedGarage, StartedRabbitMq } from '@fiapx/testing';
import { quietNestLogs, startGarage, startRabbitMq, waitFor } from '@fiapx/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Channel, ChannelModel } from 'amqplib';
import { connect } from 'amqplib';
import { WorkerModule } from '../src/worker.module';
import { describeWithFfmpeg, PNG_SIGNATURE } from './support/media';
import { readStoredEntry, readZipEntries } from './support/zip-reader';

/** The same script the E2E/BDD suites use to create their videos. */
const FIXTURES_SCRIPT = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'generate.sh');

/**
 * The real worker (WorkerModule, same wiring as production) against RabbitMQ and Garage in
 * containers and the real ffmpeg: `video.uploaded` in, `video.processing.*` out on
 * `api.video-processing` (nobody consumes it here, so the test reads it), zip in the bucket.
 */
describeWithFfmpeg('video-worker end to end (RabbitMQ, Garage and ffmpeg)', () => {
  const previousEnv = { ...process.env };
  const received: ProcessingEvent[] = [];
  let rabbit: StartedRabbitMq;
  let garage: StartedGarage;
  let admin: ChannelModel;
  let channel: Channel;
  let storage: IObjectStorage;
  let app: INestApplicationContext;
  let base: string;
  let workDir: string;

  beforeAll(async () => {
    quietNestLogs();
    base = await mkdtemp(join(tmpdir(), 'fiapx-worker-int-'));
    workDir = join(base, 'work');
    [rabbit, garage] = await Promise.all([
      startRabbitMq(),
      startGarage(),
      promisify(execFile)('bash', [FIXTURES_SCRIPT, join(base, 'fixtures')]),
    ]);
    storage = new S3ObjectStorage(
      createS3Client({
        endpoint: garage.endpoint,
        region: garage.region,
        accessKeyId: garage.accessKeyId,
        secretAccessKey: garage.secretAccessKey,
        forcePathStyle: true,
      }),
    );

    Object.assign(process.env, {
      LOG_LEVEL: 'silent',
      METRICS_PORT: '0',
      METRICS_HOST: '127.0.0.1',
      RABBITMQ_URL: rabbit.url,
      S3_ENDPOINT: garage.endpoint,
      S3_ACCESS_KEY_ID: garage.accessKeyId,
      S3_SECRET_ACCESS_KEY: garage.secretAccessKey,
      S3_BUCKET_RAW: garage.buckets.raw,
      S3_BUCKET_ZIPS: garage.buckets.zips,
      WORK_DIR: workDir,
      FFMPEG_TIMEOUT_MS: '60000',
    });
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
      abortOnError: false,
    });
    await app.get(TopologyInitializer).whenReady();
    await waitFor(() => app.get(MessageConsumers).all[0]?.isConsuming, {
      timeoutMs: 30_000,
      description: 'consumer of worker.video-uploaded active',
    });
    admin = await connect(rabbit.url);
    channel = await admin.createChannel();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await channel?.close().catch(() => undefined);
    await admin?.close();
    await Promise.all([rabbit?.stop(), garage?.stop()]);
    process.env = { ...previousEnv };
    await rm(base, { recursive: true, force: true });
  });

  async function uploadRaw(file: string): Promise<PayloadOf<'video.uploaded'>> {
    const userId = randomUUID();
    const videoId = randomUUID();
    const body = await readFile(join(base, 'fixtures', file));
    const video = {
      videoId,
      userId,
      originalName: file,
      rawBucket: garage.buckets.raw,
      rawKey: rawVideoKey(userId, videoId, 'mp4'),
      zipBucket: garage.buckets.zips,
      zipKey: zipKey(userId, videoId),
      sizeBytes: body.length,
    };
    await storage.putStream({
      bucket: video.rawBucket,
      key: video.rawKey,
      body,
      contentType: 'video/mp4',
    });
    return video;
  }

  async function publish(event: EventOf<'video.uploaded'>): Promise<void> {
    await app.get<EventPublisher>(EVENT_PUBLISHER).publishEvent(event);
  }

  /** Drains `api.video-processing` until `done` holds for the events of `videoId`. */
  function eventsOf(
    videoId: string,
    done: (events: ProcessingEvent[]) => boolean,
  ): Promise<ProcessingEvent[]> {
    return waitFor(
      async () => {
        for (;;) {
          const message = await channel.get(QUEUES.apiVideoProcessing, { noAck: true });
          if (message === false) break;
          received.push(processingEvent.parse(JSON.parse(message.content.toString())));
        }
        const events = received.filter((event) => event.payload.videoId === videoId);
        return done(events) ? events : undefined;
      },
      { timeoutMs: 60_000, intervalMs: 200, description: `processing events of ${videoId}` },
    );
  }

  const types = (events: ProcessingEvent[]) => events.map((event) => event.type);

  async function settled(): Promise<void> {
    await waitFor(
      async () => {
        const queue = await channel.checkQueue(QUEUES.workerVideoUploaded);
        return queue.messageCount === 0 && app.get(MessageConsumers).all[0]?.inFlightCount === 0;
      },
      { description: 'worker.video-uploaded drained and acked' },
    );
  }

  async function metric(line: string): Promise<boolean> {
    const port = app.get(MetricsServerService).server.port;
    return (await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()).includes(line);
  }

  async function download(bucket: string, key: string): Promise<Buffer> {
    const { body } = await storage.getStream(bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  let okVideo: PayloadOf<'video.uploaded'>;
  let okEvent: EventOf<'video.uploaded'>;

  it('sample-ok.mp4 (5 s) → started, zip with 5 PNGs in Garage, completed; scratch dir removed', async () => {
    okVideo = await uploadRaw('sample-ok.mp4');
    okEvent = createEvent('video.uploaded', okVideo, `int-ok-${okVideo.videoId}`);

    await publish(okEvent);
    const events = await eventsOf(okVideo.videoId, (e) =>
      types(e).includes('video.processing.completed'),
    );

    expect(types(events)).toEqual(['video.processing.started', 'video.processing.completed']);
    const [started, completed] = events;
    expect(started).toMatchObject({
      correlationId: okEvent.correlationId,
      payload: { attempt: 1, workerId: hostname().slice(0, 100) },
    });
    const zip = await download(okVideo.zipBucket, okVideo.zipKey);
    const entries = readZipEntries(zip);
    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.name)).toEqual(
      [1, 2, 3, 4, 5].map((i) => `frame_000${i}.png`),
    );
    for (const entry of entries) {
      expect(readStoredEntry(zip, entry).subarray(0, 8)).toEqual(PNG_SIGNATURE);
    }
    const head = await storage.head(okVideo.zipBucket, okVideo.zipKey);
    expect(head.metadata).toEqual({ 'video-id': okVideo.videoId, 'frame-count': '5' });
    expect(completed).toMatchObject({
      correlationId: okEvent.correlationId,
      payload: {
        videoId: okVideo.videoId,
        zipKey: okVideo.zipKey,
        frameCount: 5,
        zipSizeBytes: zip.length,
      },
    });

    await settled();
    expect(await readdir(workDir)).toEqual([]);
    expect(
      await metric('fiapx_worker_jobs_total{result="completed",service="video-worker"} 1'),
    ).toBe(true);
  });

  it('the same message again (redelivery) → only completed, same event id, ffmpeg skipped', async () => {
    await publish(okEvent);
    const events = await eventsOf(
      okVideo.videoId,
      (e) => types(e).filter((type) => type === 'video.processing.completed').length === 2,
    );

    expect(types(events)).toEqual([
      'video.processing.started',
      'video.processing.completed',
      'video.processing.completed',
    ]);
    expect(events[2]?.id).toBe(events[1]?.id);
    await settled();
    expect(
      await metric('fiapx_worker_jobs_total{result="duplicate",service="video-worker"} 1'),
    ).toBe(true);
  });

  it('sample-corrupt.mp4 → started, failed P0001, no zip, message acked', async () => {
    const video = await uploadRaw('sample-corrupt.mp4');

    await publish(createEvent('video.uploaded', video, `int-corrupt-${video.videoId}`));
    const events = await eventsOf(video.videoId, (e) =>
      types(e).includes('video.processing.failed'),
    );

    expect(types(events)).toEqual(['video.processing.started', 'video.processing.failed']);
    expect(events[1]?.payload).toMatchObject({ attempt: 1, errorCode: 'P0001' });
    expect(await storage.exists(video.zipBucket, video.zipKey)).toBe(false);
    await settled();
    expect(await readdir(workDir)).toEqual([]);
  });

  it('raw video missing from the bucket → failed P0005', async () => {
    const userId = randomUUID();
    const videoId = randomUUID();
    const video = {
      videoId,
      userId,
      originalName: 'gone.mp4',
      rawBucket: garage.buckets.raw,
      rawKey: rawVideoKey(userId, videoId, 'mp4'),
      zipBucket: garage.buckets.zips,
      zipKey: zipKey(userId, videoId),
      sizeBytes: 1024,
    };

    await publish(createEvent('video.uploaded', video, `int-missing-${videoId}`));
    const events = await eventsOf(videoId, (e) => types(e).includes('video.processing.failed'));

    expect(events.at(-1)?.payload).toMatchObject({ errorCode: 'P0005' });
    await settled();
    const dlq = await channel.checkQueue(`${QUEUES.workerVideoUploaded}.dlq`);
    expect(dlq.messageCount).toBe(0);
  });
});
