import { GlobalExceptionFilter } from '@fiapx/common';
import { OBJECT_STORAGE, STORAGE_BUCKETS } from '@fiapx/storage';
import { InMemoryObjectStorage } from '@fiapx/storage/testing';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import {
  aVideo,
  FakeUnitOfWork,
  FixedClock,
  MapIdempotencyCache,
  OTHER_USER_ID,
  RecordingVideoMetrics,
  USER_ID,
  VIDEO_ID,
} from '../../../../../test/support/fakes';
import { mp4Bytes, pngBytes } from '../../../../../test/support/media';
import { UNIT_OF_WORK } from '../../../../shared/application/unit-of-work';
import { CLOCK } from '../../../../shared/domain/clock';
import { IS_PUBLIC_ROUTE } from '../../../auth/interfaces/decorators/public.decorator';
import { DOWNLOAD_SIGNER } from '../../application/ports/download.signer';
import { FILE_SIGNATURE_INSPECTOR } from '../../application/ports/file-signature.inspector';
import { IDEMPOTENCY_CACHE } from '../../application/ports/idempotency.cache';
import { VIDEO_METRICS } from '../../application/ports/video.metrics';
import { CreateDownloadUrlUseCase } from '../../application/use-cases/create-download-url.use-case';
import { GetVideoUseCase } from '../../application/use-cases/get-video.use-case';
import { ListVideosUseCase } from '../../application/use-cases/list-videos.use-case';
import { OpenDownloadUseCase } from '../../application/use-cases/open-download.use-case';
import { UploadVideoUseCase } from '../../application/use-cases/upload-video.use-case';
import type { VideoSettings } from '../../application/video.settings';
import { VIDEO_SETTINGS } from '../../application/video.settings';
import { VIDEO_REPOSITORY } from '../../domain/video.repository';
import { FileTypeSignatureInspector } from '../../infrastructure/file-signature/file-type-signature.inspector';
import { HmacDownloadSigner } from '../../infrastructure/signing/hmac-download.signer';
import { DownloadsController } from './downloads.controller';
import { VideosController } from './videos.controller';

/** Stand-in for the JWT guard: `x-test-user` picks the authenticated user. */
@Injectable()
class TestAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride(IS_PUBLIC_ROUTE, [context.getHandler(), context.getClass()])
    ) {
      return true;
    }
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    req.user = { id: req.headers['x-test-user'] ?? USER_ID };
    return true;
  }
}

const settings: VideoSettings = {
  maxUploadMb: 1,
  maxUploadBytes: 1024 * 1024,
  publicBaseUrl: 'http://api.test',
  downloadUrlTtlSeconds: 300,
  zipRetentionDays: 7,
};

async function createApp() {
  const uow = new FakeUnitOfWork();
  const storage = new InMemoryObjectStorage();
  const metrics = new RecordingVideoMetrics();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }] }),
    ],
    controllers: [VideosController, DownloadsController],
    providers: [
      UploadVideoUseCase,
      ListVideosUseCase,
      GetVideoUseCase,
      CreateDownloadUrlUseCase,
      OpenDownloadUseCase,
      { provide: UNIT_OF_WORK, useValue: uow },
      { provide: VIDEO_REPOSITORY, useValue: uow.videos },
      { provide: OBJECT_STORAGE, useValue: storage },
      { provide: STORAGE_BUCKETS, useValue: { raw: 'fiapx-raw', zips: 'fiapx-zips' } },
      { provide: FILE_SIGNATURE_INSPECTOR, useClass: FileTypeSignatureInspector },
      { provide: IDEMPOTENCY_CACHE, useValue: new MapIdempotencyCache() },
      { provide: VIDEO_METRICS, useValue: metrics },
      { provide: CLOCK, useValue: new FixedClock(new Date()) },
      { provide: VIDEO_SETTINGS, useValue: settings },
      { provide: DOWNLOAD_SIGNER, useValue: new HmacDownloadSigner('s'.repeat(48)) },
      { provide: APP_GUARD, useClass: TestAuthGuard },
      { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  return { app, uow, storage, metrics };
}

describe('VideosController + DownloadsController (HTTP)', () => {
  let ctx: Awaited<ReturnType<typeof createApp>>;
  beforeEach(async () => {
    ctx = await createApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  const http = () => request(ctx.app.getHttpServer());

  it('POST /api/videos → 202 QUEUED, object stored, outbox written', async () => {
    const res = await http()
      .post('/api/videos')
      .attach('video', mp4Bytes(2048), 'demo.mp4')
      .expect(202);

    expect(res.body).toEqual({
      id: expect.any(String),
      originalName: 'demo.mp4',
      status: 'QUEUED',
    });
    expect(ctx.storage.size).toBe(1);
    expect(ctx.uow.outbox.ofType('video.uploaded')).toHaveLength(1);
    expect(ctx.metrics.uploadedCount).toBe(1);
  });

  it('same Idempotency-Key → same video, body drained, nothing duplicated', async () => {
    const first = await http()
      .post('/api/videos')
      .set('Idempotency-Key', 'b5d9c1c4-8e0f-4a5b-9c7d-1e2f3a4b5c6d')
      .attach('video', mp4Bytes(), 'demo.mp4')
      .expect(202);
    const second = await http()
      .post('/api/videos')
      .set('Idempotency-Key', 'b5d9c1c4-8e0f-4a5b-9c7d-1e2f3a4b5c6d')
      .attach('video', mp4Bytes(200_000), 'demo.mp4')
      .expect(202);

    expect(second.body).toEqual(first.body);
    expect(ctx.uow.videos.videos.size).toBe(1);
    expect(ctx.storage.size).toBe(1);
  });

  it('invalid Idempotency-Key → 400 X0001', async () => {
    const res = await http()
      .post('/api/videos')
      .set('Idempotency-Key', 'não vale')
      .attach('video', mp4Bytes(), 'demo.mp4')
      .expect(400);
    expect(res.body.error).toMatchObject({
      code: 'X0001',
      metadata: { fields: [{ field: 'Idempotency-Key' }] },
    });
  });

  it('Content-Length above MAX_UPLOAD_MB → 413 V0003 before reading the body', async () => {
    const res = await http()
      .post('/api/videos')
      .attach('video', mp4Bytes(2 * 1024 * 1024), 'big.mp4')
      .expect(413);
    expect(res.body.error).toMatchObject({ code: 'V0003', metadata: { maxMb: 1 } });
    expect(ctx.storage.size).toBe(0);
  });

  it('wrong format → 400 V0002 with the accepted extensions', async () => {
    const res = await http()
      .post('/api/videos')
      .attach('video', pngBytes(), 'foto.mp4')
      .expect(400);
    expect(res.body.error).toMatchObject({
      code: 'V0002',
      metadata: { allowed: ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm'] },
    });
  });

  it('missing file → 400 X0001', async () => {
    await http().post('/api/videos').field('x', 'y').expect(400);
  });

  it('GET /api/videos lists only the user videos, validating the query', async () => {
    ctx.uow.videos.add(aVideo());
    ctx.uow.videos.add(
      aVideo({ id: '8a1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4d', userId: OTHER_USER_ID }),
    );

    const res = await http().get('/api/videos?page=1&limit=20&status=QUEUED').expect(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, limit: 20, items: [{ id: VIDEO_ID }] });

    const invalid = await http().get('/api/videos?limit=1000&status=DONE').expect(400);
    expect(invalid.body.error.code).toBe('X0001');
  });

  it('GET /api/videos/:id → detail for the owner, 404 V0001 for anyone else', async () => {
    ctx.uow.videos.add(aVideo());
    await http().get(`/api/videos/${VIDEO_ID}`).expect(200);
    const res = await http()
      .get(`/api/videos/${VIDEO_ID}`)
      .set('x-test-user', OTHER_USER_ID)
      .expect(404);
    expect(res.body.error.code).toBe('V0001');
  });

  it('download-url → signed link; GET /api/downloads streams the zip with safe headers', async () => {
    const zipKey = `${USER_ID}/${VIDEO_ID}.zip`;
    ctx.uow.videos.add(
      aVideo({ status: 'COMPLETED', zipKey, frameCount: 2, originalName: 'férias.mp4' }),
    );
    await ctx.storage.putStream({
      bucket: 'fiapx-zips',
      key: zipKey,
      body: Buffer.from('PK\u0003\u0004zip'),
    });

    const link = await http().post(`/api/videos/${VIDEO_ID}/download-url`).expect(200);
    expect(link.body.url).toMatch(/^http:\/\/api\.test\/api\/downloads\//);
    const url = new URL(link.body.url as string);

    const res = await http().get(`${url.pathname}${url.search}`).expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-length']).toBe('7');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="f_rias_frames.zip"; filename*=UTF-8''f%C3%A9rias_frames.zip`,
    );

    const forged = await http()
      .get(`${url.pathname}?exp=${url.searchParams.get('exp')}&sig=forjada`)
      .expect(403);
    expect(forged.body.error.code).toBe('V0005');
  });

  it('download-url of a video still processing → 409 V0004', async () => {
    ctx.uow.videos.add(aVideo({ status: 'PROCESSING' }));
    const res = await http().post(`/api/videos/${VIDEO_ID}/download-url`).expect(409);
    expect(res.body.error.code).toBe('V0004');
  });
});
