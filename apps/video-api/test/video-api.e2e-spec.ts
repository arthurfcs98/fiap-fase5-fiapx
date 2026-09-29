import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { EventType, FiapxEvent } from '@fiapx/contracts';
import { createEvent, fiapxEvent } from '@fiapx/contracts';
import { EXCHANGES, QUEUES } from '@fiapx/messaging';
import { MetricsServerService } from '@fiapx/observability';
import { createS3Client, S3ObjectStorage } from '@fiapx/storage';
import type { StartedGarage, StartedPostgres, StartedRabbitMq, StartedRedis } from '@fiapx/testing';
import {
  quietNestLogs,
  startGarage,
  startPostgres,
  startRabbitMq,
  startRedis,
  waitFor,
} from '@fiapx/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import type { Channel, ChannelModel } from 'amqplib';
import { connect } from 'amqplib';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { ApiConfig } from '../src/config/api.config';
import { API_CONFIG } from '../src/config/api.config';
import { runMigrationCli } from '../src/database/migration-cli';
import { ExpireZipsUseCase } from '../src/modules/videos/application/use-cases/expire-zips.use-case';
import { mp4Bytes, pngBytes } from './support/media';

/**
 * End-to-end: the real AppModule (same HTTP pipeline as main.ts) against REAL Postgres, Redis,
 * RabbitMQ and Garage, started by Testcontainers from the images pinned in compose.yaml (the same
 * way the lib integration tests do, so it runs in CI without the compose stack). The worker is
 * simulated by publishing its events on the broker.
 */
jest.setTimeout(240_000);

const JWT_SECRET = randomUUID() + randomUUID();
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

interface Session {
  token: string;
  userId: string;
  email: string;
  password: string;
}

describe('video-api (e2e with Postgres, Redis, RabbitMQ and Garage)', () => {
  let postgres: StartedPostgres;
  let redis: StartedRedis;
  let rabbit: StartedRabbitMq;
  let garage: StartedGarage;
  let app: NestExpressApplication;
  let db: DataSource;
  let amqp: ChannelModel;
  let channel: Channel;
  let storage: S3ObjectStorage;
  const previousEnv = { ...process.env };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    quietNestLogs();
    [postgres, redis, rabbit, garage] = await Promise.all([
      startPostgres('fiapx_video'),
      startRedis(),
      startRabbitMq(),
      startGarage(),
    ]);

    const env: Record<string, string> = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_VERSION: 'e2e-sha1234',
      METRICS_PORT: '0',
      METRICS_HOST: '127.0.0.1',
      DB_HOST: postgres.host,
      DB_PORT: String(postgres.port),
      DB_USER: postgres.user,
      DB_PASSWORD: postgres.password,
      DB_NAME: postgres.database,
      DB_SSL: 'false',
      REDIS_URL: redis.url,
      RABBITMQ_URL: rabbit.url,
      S3_ENDPOINT: garage.endpoint,
      S3_REGION: garage.region,
      S3_ACCESS_KEY_ID: garage.accessKeyId,
      S3_SECRET_ACCESS_KEY: garage.secretAccessKey,
      JWT_SECRET,
      DOWNLOAD_URL_SECRET: randomUUID() + randomUUID(),
      PUBLIC_BASE_URL: 'http://api.e2e',
      MAX_UPLOAD_MB: '1',
      ZIP_RETENTION_DAYS: '7',
    };
    Object.assign(process.env, env);

    // Same one-shot the K8s Job / compose service runs (idempotent: the second run is a no-op).
    await expect(runMigrationCli({ env, write: () => undefined })).resolves.toEqual([
      'Init1790553600000',
      'StatusHistoryIndex1790640000000',
    ]);
    await expect(runMigrationCli({ env, write: () => undefined })).resolves.toEqual([]);

    // NestFactory (like main.ts), not Test.createTestingModule: ServeStaticModule picks its
    // Express loader from the HTTP adapter, which the testing module only attaches later.
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bufferLogs: true,
      abortOnError: false,
    });
    configureApp(app, app.get<ApiConfig>(API_CONFIG));
    await app.init();

    db = app.get(DataSource);
    amqp = await connect(rabbit.url);
    channel = await amqp.createChannel();
    storage = new S3ObjectStorage(
      createS3Client({
        endpoint: garage.endpoint,
        region: garage.region,
        accessKeyId: garage.accessKeyId,
        secretAccessKey: garage.secretAccessKey,
        forcePathStyle: true,
      }),
    );
    // The API declares the topology on connect: wait for the queues it consumes.
    await waitFor(
      async () => {
        // A failed checkQueue closes the channel: probe on a throwaway one.
        const probe = await amqp.createChannel();
        probe.on('error', () => undefined);
        try {
          await probe.checkQueue(QUEUES.apiVideoProcessing);
          await probe.checkQueue(QUEUES.apiVideoDeadLetter);
          return true;
        } finally {
          await probe.close().catch(() => undefined);
        }
      },
      { timeoutMs: 30_000, description: 'topologia declarada pela API' },
    );
  });

  afterAll(async () => {
    await amqp?.close().catch(() => undefined);
    await app?.close();
    await Promise.all([postgres, redis, rabbit, garage].map((c) => c?.stop()));
    process.env = previousEnv;
  });

  // ------------------------------------------------------------------ helpers
  async function signUp(name = 'Ana Souza'): Promise<Session> {
    const email = `ana.${randomUUID().slice(0, 8)}@example.com`;
    const password = 'senha-forte-123';
    const created = await http()
      .post('/api/auth/register')
      .send({ name, email, password, acceptPrivacyPolicy: true })
      .expect(201);
    const login = await http().post('/api/auth/login').send({ email, password }).expect(200);
    return {
      token: login.body.accessToken as string,
      userId: created.body.id as string,
      email,
      password,
    };
  }

  function upload(session: Session, bytes = mp4Bytes(4096), name = 'demo.mp4') {
    return http()
      .post('/api/videos')
      .set('Authorization', `Bearer ${session.token}`)
      .attach('video', bytes, name);
  }

  async function videoOf(session: Session, id: string) {
    const res = await http()
      .get(`/api/videos/${id}`)
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200);
    return res.body as {
      status: string;
      errorCode: string | null;
      history: { toStatus: string }[];
    };
  }

  async function waitForStatus(session: Session, id: string, status: string) {
    return waitFor(
      async () => {
        const video = await videoOf(session, id);
        return video.status === status ? video : undefined;
      },
      { timeoutMs: 20_000, description: `vídeo ${id} em ${status}` },
    );
  }

  /** Next message of `queue` matching `predicate` (acked); other messages are acked too. */
  async function takeMessage<K extends EventType>(
    queue: string,
    type: K,
    predicate: (event: Extract<FiapxEvent, { type: K }>) => boolean,
  ) {
    return waitFor(
      async () => {
        const message = await channel.get(queue, { noAck: true });
        if (!message) return undefined;
        const event = fiapxEvent.parse(JSON.parse(message.content.toString()));
        if (event.type !== type) return undefined;
        const typed = event as Extract<FiapxEvent, { type: K }>;
        return predicate(typed) ? { event: typed, properties: message.properties } : undefined;
      },
      { timeoutMs: 20_000, description: `${type} em ${queue}` },
    );
  }

  /** Publishes like the worker does (messageId, correlationId, type, persistent). */
  function publishAsWorker(
    event: FiapxEvent,
    exchange: string = EXCHANGES.events,
    routingKey: string = event.type,
  ) {
    channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(event)), {
      messageId: event.id,
      correlationId: event.correlationId,
      type: event.type,
      contentType: 'application/json',
      persistent: true,
      headers: { 'x-correlation-id': event.correlationId },
    });
  }

  async function uploadedEventFor(videoId: string) {
    return takeMessage(
      QUEUES.workerVideoUploaded,
      'video.uploaded',
      (e) => e.payload.videoId === videoId,
    );
  }

  // -------------------------------------------------------------------- tests
  it('health: live with the build version, ready checks Postgres + storage', async () => {
    const live = await http().get('/api/health/live').expect(200);
    expect(live.body).toEqual({ status: 'ok', service: 'video-api', version: 'e2e-sha1234' });

    // Public route: only up/down, never the checks' details (hosts, database user).
    const ready = await http().get('/api/health/ready').expect(200);
    expect(ready.body).toEqual({ status: 'ok', service: 'video-api', version: 'e2e-sha1234' });
  });

  it('serves the static frontend at / and keeps /api for the API', async () => {
    if (existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
      const res = await http().get('/').expect(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    }
    const notFound = await http()
      .get('/api/nao-existe')
      .set('x-correlation-id', 'cid-404')
      .expect(404);
    expect(notFound.body).toMatchObject({ error: { code: 'X0404' }, correlationId: 'cid-404' });
  });

  it('Swagger documents the video and LGPD routes', async () => {
    const res = await http().get('/api/docs-json').expect(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/auth/register',
        '/api/videos',
        '/api/videos/{id}/download-url',
        '/api/downloads/{id}',
        '/api/me/data',
        '/api/me',
      ]),
    );
  });

  it('auth: consent required, duplicate e-mail, bad credentials, token required', async () => {
    const email = `bob.${randomUUID().slice(0, 8)}@example.com`;
    const body = { name: 'Bob', email, password: 'senha-forte-123' };

    const noConsent = await http().post('/api/auth/register').send(body).expect(400);
    expect(noConsent.body.error).toMatchObject({ code: 'X0001' });

    await http()
      .post('/api/auth/register')
      .send({ ...body, acceptPrivacyPolicy: true })
      .expect(201);
    const duplicate = await http()
      .post('/api/auth/register')
      .send({ ...body, email: email.toUpperCase(), acceptPrivacyPolicy: true })
      .expect(409);
    expect(duplicate.body.error.code).toBe('A0002');

    const consent = await db.query<{ privacy_policy_version: string; privacy_accepted_at: Date }[]>(
      'SELECT privacy_policy_version, privacy_accepted_at FROM users WHERE email = $1',
      [email],
    );
    expect(consent[0]).toMatchObject({ privacy_policy_version: '2026-09-28' });

    const wrong = await http()
      .post('/api/auth/login')
      .send({ email, password: 'errada-123' })
      .expect(401);
    expect(wrong.body.error.code).toBe('A0001');
    const login = await http()
      .post('/api/auth/login')
      .send({ email, password: 'senha-forte-123' })
      .expect(200);
    expect(login.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600 });

    const me = await http()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
    expect(me.body).toEqual({ id: expect.any(String), name: 'Bob', email });

    const anonymous = await http().get('/api/videos').expect(401);
    expect(anonymous.body.error.code).toBe('A0003');
    await http().get('/api/videos').set('Authorization', 'Bearer x.y.z').expect(401);
  });

  it('login is throttled to 5 per minute per IP + e-mail (Redis)', async () => {
    const email = `throttle.${randomUUID().slice(0, 8)}@example.com`;
    for (let i = 0; i < 5; i += 1) {
      await http().post('/api/auth/login').send({ email, password: 'x' }).expect(401);
    }
    const blocked = await http().post('/api/auth/login').send({ email, password: 'x' }).expect(429);
    expect(blocked.body.error.code).toBe('X0429');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('happy path: upload → outbox → worker events → COMPLETED → signed download; raw deleted', async () => {
    const session = await signUp();
    const bytes = mp4Bytes(8192);
    const key = randomUUID();

    const accepted = await upload(session, bytes, 'férias.mp4')
      .set('Idempotency-Key', key)
      .set('x-correlation-id', 'e2e-upload-1')
      .expect(202);
    expect(accepted.body).toEqual({
      id: expect.any(String),
      originalName: 'férias.mp4',
      status: 'QUEUED',
    });
    const videoId = accepted.body.id as string;

    // Same Idempotency-Key → same video, nothing duplicated.
    const replay = await upload(session, bytes, 'férias.mp4')
      .set('Idempotency-Key', key)
      .expect(202);
    expect(replay.body.id).toBe(videoId);

    // Outbox relay → RabbitMQ with publisher confirm, same correlation id end to end.
    const uploaded = await uploadedEventFor(videoId);
    expect(uploaded.properties).toMatchObject({
      correlationId: 'e2e-upload-1',
      messageId: uploaded.event.id,
    });
    expect(uploaded.event.payload).toMatchObject({
      userId: session.userId,
      originalName: 'férias.mp4',
      rawBucket: 'fiapx-raw',
      zipBucket: 'fiapx-zips',
      sizeBytes: bytes.length,
    });
    const { rawKey, zipKey } = uploaded.event.payload;
    expect(rawKey).toBe(`${session.userId}/${videoId}.mp4`);
    await expect(storage.exists('fiapx-raw', rawKey)).resolves.toBe(true);
    const outbox = await db.query<{ published_at: Date | null }[]>(
      'SELECT published_at FROM outbox_events WHERE aggregate_id = $1',
      [videoId],
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.published_at).not.toBeNull();

    // Worker: started → (zip in the bucket) → completed.
    const cid = uploaded.event.correlationId;
    publishAsWorker(
      createEvent('video.processing.started', { videoId, attempt: 1, workerId: 'e2e-worker' }, cid),
    );
    await waitForStatus(session, videoId, 'PROCESSING');

    const zip = Buffer.from('PK\u0003\u0004 fake zip');
    await storage.putStream({
      bucket: 'fiapx-zips',
      key: zipKey,
      body: zip,
      contentType: 'application/zip',
    });
    const completed = createEvent(
      'video.processing.completed',
      { videoId, zipKey, frameCount: 3, zipSizeBytes: zip.length, durationMs: 42 },
      cid,
    );
    publishAsWorker(completed);
    publishAsWorker(completed); // redelivery: idempotent (processed_messages)
    const detail = await waitForStatus(session, videoId, 'COMPLETED');
    expect(detail.history.map((h) => h.toStatus)).toEqual(['QUEUED', 'PROCESSING', 'COMPLETED']);

    // LGPD: the original video is deleted once the video is terminal.
    await waitFor(async () => !(await storage.exists('fiapx-raw', rawKey)), { timeoutMs: 10_000 });

    // Notification event through the outbox (the only event with e-mail/name).
    const notification = await takeMessage(
      QUEUES.notificationEvents,
      'video.completed',
      (e) => e.payload.videoId === videoId,
    );
    expect(notification.event.payload).toMatchObject({
      userId: session.userId,
      userEmail: session.email,
      userName: 'Ana Souza',
      frameCount: 3,
    });
    expect(notification.properties.correlationId).toBe('e2e-upload-1');

    // Signed download link (5 min) and zip streaming.
    const link = await http()
      .post(`/api/videos/${videoId}/download-url`)
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200);
    const url = new URL(link.body.url as string);
    expect(url.origin).toBe('http://api.e2e');
    const download = await http()
      .get(`${url.pathname}${url.search}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['content-disposition']).toContain(
      `filename*=UTF-8''f%C3%A9rias_frames.zip`,
    );
    expect(download.headers['cache-control']).toBe('no-store');
    expect((download.body as Buffer).equals(zip)).toBe(true);
    await http()
      .get(`${url.pathname}?exp=${url.searchParams.get('exp')}&sig=forjada`)
      .expect(403);

    // Isolation: another user gets 404.
    const other = await signUp('Carla');
    await http()
      .get(`/api/videos/${videoId}`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(404);
    const list = await http()
      .get('/api/videos')
      .set('Authorization', `Bearer ${other.token}`)
      .expect(200);
    expect(list.body).toMatchObject({ total: 0, items: [] });

    // Zip retention (LGPD): completed 8 days ago → zip deleted, download 410 V0006.
    await db.query(`UPDATE videos SET completed_at = now() - interval '8 days' WHERE id = $1`, [
      videoId,
    ]);
    await expect(app.get(ExpireZipsUseCase).execute()).resolves.toMatchObject({
      skipped: false,
      expired: 1,
    });
    await expect(storage.exists('fiapx-zips', zipKey)).resolves.toBe(false);
    const gone = await http()
      .post(`/api/videos/${videoId}/download-url`)
      .set('Authorization', `Bearer ${session.token}`)
      .expect(410);
    expect(gone.body.error.code).toBe('V0006');
    await http().get(`${url.pathname}${url.search}`).expect(410);
  });

  it('upload validation: wrong format → 400 V0002, over MAX_UPLOAD_MB → 413 V0003', async () => {
    const session = await signUp();
    const format = await upload(session, pngBytes(), 'foto.mp4').expect(400);
    expect(format.body.error.code).toBe('V0002');
    const big = await upload(session, mp4Bytes(2 * 1024 * 1024), 'grande.mp4').expect(413);
    expect(big.body.error.code).toBe('V0003');
  });

  it('failure paths: processing.failed → FAILED P0001; dead-letter → FAILED P0099 (+ video.failed)', async () => {
    const session = await signUp();

    const first = (await upload(session).expect(202)).body.id as string;
    const firstUploaded = await uploadedEventFor(first);
    publishAsWorker(
      createEvent(
        'video.processing.failed',
        {
          videoId: first,
          attempt: 1,
          errorCode: 'P0001',
          errorMessage: 'O arquivo não é um vídeo válido.',
        },
        firstUploaded.event.correlationId,
      ),
    );
    const failed = await waitForStatus(session, first, 'FAILED');
    expect(failed.errorCode).toBe('P0001');
    const failedNotification = await takeMessage(
      QUEUES.notificationEvents,
      'video.failed',
      (e) => e.payload.videoId === first,
    );
    expect(failedNotification.event.payload).toMatchObject({
      errorCode: 'P0001',
      userEmail: session.email,
    });
    await waitFor(
      async () => !(await storage.exists('fiapx-raw', firstUploaded.event.payload.rawKey)),
    );

    // Dead-letter: the worker gave up on the message → fiapx.dlx → api.video-deadletter.
    const second = (await upload(session).expect(202)).body.id as string;
    const secondUploaded = await uploadedEventFor(second);
    publishAsWorker(secondUploaded.event, EXCHANGES.deadLetter, QUEUES.workerVideoUploaded);
    const aborted = await waitForStatus(session, second, 'FAILED');
    expect(aborted.errorCode).toBe('P0099');
    await takeMessage(
      QUEUES.notificationEvents,
      'video.failed',
      (e) => e.payload.videoId === second && e.payload.errorCode === 'P0099',
    );

    // A late event after the terminal state is ignored (and acked).
    publishAsWorker(
      createEvent(
        'video.processing.started',
        { videoId: second, attempt: 2, workerId: 'late' },
        'cid-late',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await videoOf(session, second)).status).toBe('FAILED');
  });

  it('metrics: business counters, outbox gauge and the HTTP histogram with the route pattern', async () => {
    const port = app.get(MetricsServerService).server.port;
    const text = await waitFor(async () => {
      const body = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      return /fiapx_outbox_pending\{[^}]*\} 0\n/.test(body) ? body : undefined;
    });
    expect(text).toMatch(/fiapx_videos_uploaded_total\{[^}]*\} [1-9]/);
    expect(text).toMatch(/fiapx_videos_completed_total\{[^}]*\} [1-9]/);
    expect(text).toContain('error_code="P0099"');
    expect(text).toContain('route="/api/videos/:id"');
    expect(text).toMatch(
      /fiapx_http_request_duration_seconds_count\{[^}]*method="POST",route="\/api\/videos",status="202"/,
    );
    expect(text).not.toMatch(/route="\/api\/videos\/[0-9a-f]{8}-/);
    expect(text).not.toContain('@example.com');
  });

  it('LGPD: export my data, erase the account (password confirmation), old token revoked', async () => {
    const session = await signUp('Dora');
    const videoId = (await upload(session).expect(202)).body.id as string;
    const uploaded = await uploadedEventFor(videoId);

    const exported = await http()
      .get('/api/me/data')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200);
    expect(exported.body.user).toMatchObject({
      id: session.userId,
      email: session.email,
      privacyPolicyVersion: '2026-09-28',
    });
    expect(exported.body.user).not.toHaveProperty('passwordHash');
    expect(exported.body.videos).toEqual([
      expect.objectContaining({
        id: videoId,
        history: [expect.objectContaining({ toStatus: 'QUEUED' })],
      }),
    ]);

    const wrong = await http()
      .delete('/api/me')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ password: 'errada-123' })
      .expect(400);
    expect(wrong.body.error.code).toBe('A0004');
    await http().get('/api/auth/me').set('Authorization', `Bearer ${session.token}`).expect(200);

    await http()
      .delete('/api/me')
      .set('Authorization', `Bearer ${session.token}`)
      .set('x-correlation-id', 'e2e-lgpd-1')
      .send({ password: session.password })
      .expect(204);

    const revoked = await http()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(401);
    expect(revoked.body.error.code).toBe('A0003');
    await http()
      .post('/api/auth/login')
      .send({ email: session.email, password: session.password })
      .expect(401);

    const rows = await db.query<{ n: number }[]>(
      `SELECT (SELECT count(*) FROM users WHERE id = $1)::int
            + (SELECT count(*) FROM videos WHERE user_id = $1)::int
            + (SELECT count(*) FROM video_status_history WHERE video_id = $2)::int AS n`,
      [session.userId, videoId],
    );
    expect(rows[0]?.n).toBe(0);
    await expect(storage.exists('fiapx-raw', uploaded.event.payload.rawKey)).resolves.toBe(false);

    const deleted = await takeMessage(
      QUEUES.notificationEvents,
      'user.deleted',
      (e) => e.payload.userId === session.userId,
    );
    expect(deleted.properties.correlationId).toBe('e2e-lgpd-1');
  });
});
