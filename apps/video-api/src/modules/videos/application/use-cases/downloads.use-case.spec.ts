import type { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { InMemoryObjectStorage } from '@fiapx/storage/testing';
import {
  aVideo,
  FixedClock,
  InMemoryVideoRepository,
  NOW,
  OTHER_USER_ID,
  USER_ID,
  VIDEO_ID,
} from '../../../../../test/support/fakes';
import { HmacDownloadSigner } from '../../infrastructure/signing/hmac-download.signer';
import type { VideoSettings } from '../video.settings';
import { CreateDownloadUrlUseCase } from './create-download-url.use-case';
import { OpenDownloadUseCase, zipFileName } from './open-download.use-case';

const buckets = { raw: 'fiapx-raw', zips: 'fiapx-zips' };
const settings: VideoSettings = {
  maxUploadMb: 95,
  maxUploadBytes: 95 * 1024 * 1024,
  publicBaseUrl: 'https://fiapx.asdevit.com',
  downloadUrlTtlSeconds: 300,
  zipRetentionDays: 7,
};
const ZIP_KEY = `${USER_ID}/${VIDEO_ID}.zip`;

async function setup(overrides: Parameters<typeof aVideo>[0] = {}) {
  const videos = new InMemoryVideoRepository();
  videos.add(aVideo({ status: 'COMPLETED', zipKey: ZIP_KEY, frameCount: 3, ...overrides }));
  const storage = new InMemoryObjectStorage();
  await storage.putStream({ bucket: 'fiapx-zips', key: ZIP_KEY, body: Buffer.from('PK-zip') });
  const signer = new HmacDownloadSigner('s'.repeat(48));
  const clock = new FixedClock();
  return {
    videos,
    storage,
    signer,
    clock,
    create: new CreateDownloadUrlUseCase(videos, signer, settings, clock),
    open: new OpenDownloadUseCase(videos, signer, storage, buckets, clock),
  };
}

function queryOf(url: string) {
  const parsed = new URL(url);
  return { exp: parsed.searchParams.get('exp') ?? '', sig: parsed.searchParams.get('sig') ?? '' };
}

async function read(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

describe('CreateDownloadUrlUseCase', () => {
  it('signs a 5-minute link on PUBLIC_BASE_URL', async () => {
    const { create } = await setup();
    const link = await create.execute(USER_ID, VIDEO_ID);

    const expiresAt = Math.floor(NOW.getTime() / 1000) + 300;
    expect(link.expiresAt).toBe(new Date(expiresAt * 1000).toISOString());
    expect(link.url).toMatch(
      new RegExp(
        `^https://fiapx\\.asdevit\\.com/api/downloads/${VIDEO_ID}\\?exp=${expiresAt}&sig=[\\w-]{43}$`,
      ),
    );
  });

  it('another user → 404 V0001; not COMPLETED → 409 V0004; expired → 410 V0006', async () => {
    const { create } = await setup();
    await expect(create.execute(OTHER_USER_ID, VIDEO_ID)).rejects.toMatchObject({
      appError: { code: 'V0001' },
    });
    await expect(create.execute(USER_ID, 'nope')).rejects.toMatchObject({
      appError: { code: 'V0001' },
    });

    const processing = await setup({ status: 'PROCESSING', zipKey: null });
    await expect(processing.create.execute(USER_ID, VIDEO_ID)).rejects.toMatchObject({
      appError: { code: 'V0004', httpStatus: 409, metadata: { status: 'PROCESSING' } },
    });

    const expired = await setup({ zipKey: null, expiredAt: NOW });
    await expect(expired.create.execute(USER_ID, VIDEO_ID)).rejects.toMatchObject({
      appError: { code: 'V0006', httpStatus: 410 },
    });
  });
});

describe('OpenDownloadUseCase', () => {
  it('valid signature → zip stream with the download name', async () => {
    const { create, open } = await setup({ originalName: 'férias.mov' });
    const { exp, sig } = queryOf((await create.execute(USER_ID, VIDEO_ID)).url);

    const zip = await open.execute({ videoId: VIDEO_ID, expires: exp, signature: sig });

    expect(zip.fileName).toBe('férias_frames.zip');
    expect(zip.sizeBytes).toBe(6);
    await expect(read(zip.body)).resolves.toBe('PK-zip');
  });

  it.each([
    [
      'tampered signature',
      (q: { exp: string; sig: string }) => ({ expires: q.exp, signature: `${q.sig}x` }),
    ],
    [
      'other expiry',
      (q: { exp: string; sig: string }) => ({
        expires: String(Number(q.exp) + 1),
        signature: q.sig,
      }),
    ],
    [
      'non-numeric expiry',
      (q: { exp: string; sig: string }) => ({ expires: '1e10', signature: q.sig }),
    ],
    ['missing params', () => ({ expires: undefined, signature: undefined })],
    ['array params', (q: { exp: string; sig: string }) => ({ expires: [q.exp], signature: q.sig })],
  ])('%s → 403 V0005', async (_case, build) => {
    const { create, open } = await setup();
    const query = queryOf((await create.execute(USER_ID, VIDEO_ID)).url);
    await expect(open.execute({ videoId: VIDEO_ID, ...build(query) })).rejects.toMatchObject({
      appError: { code: 'V0005', httpStatus: 403 },
    });
  });

  it('expired link → 403 V0005', async () => {
    const { create, open, clock } = await setup();
    const { exp, sig } = queryOf((await create.execute(USER_ID, VIDEO_ID)).url);
    clock.advance(301_000);
    await expect(
      open.execute({ videoId: VIDEO_ID, expires: exp, signature: sig }),
    ).rejects.toMatchObject({
      appError: { code: 'V0005' },
    });
  });

  it('malformed video id → 403 V0005 (no query on uuid columns)', async () => {
    const { open } = await setup();
    await expect(
      open.execute({ videoId: 'x', expires: '1', signature: 's' }),
    ).rejects.toMatchObject({
      appError: { code: 'V0005' },
    });
  });

  it('signed but gone/expired/not ready videos', async () => {
    const valid = async (overrides: Parameters<typeof aVideo>[0]) => {
      const ctx = await setup(overrides);
      const exp = Math.floor(NOW.getTime() / 1000) + 60;
      return {
        ctx,
        request: {
          videoId: VIDEO_ID,
          expires: String(exp),
          signature: ctx.signer.sign(VIDEO_ID, exp),
        },
      };
    };

    const deleted = await valid({});
    deleted.ctx.videos.videos.clear();
    await expect(deleted.ctx.open.execute(deleted.request)).rejects.toMatchObject({
      appError: { code: 'V0001' },
    });

    const expired = await valid({ zipKey: null, expiredAt: NOW });
    await expect(expired.ctx.open.execute(expired.request)).rejects.toMatchObject({
      appError: { code: 'V0006' },
    });

    const queued = await valid({ status: 'QUEUED', zipKey: null });
    await expect(queued.ctx.open.execute(queued.request)).rejects.toMatchObject({
      appError: { code: 'V0004' },
    });
  });

  it('zip missing in the storage (retention race) → 410; storage down → 503', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const ctx = await setup();
    const exp = Math.floor(NOW.getTime() / 1000) + 60;
    const request = {
      videoId: VIDEO_ID,
      expires: String(exp),
      signature: ctx.signer.sign(VIDEO_ID, exp),
    };

    ctx.storage.failNext('get');
    await expect(ctx.open.execute(request)).rejects.toMatchObject({
      appError: { code: 'X0003', httpStatus: 503 },
    });
    jest.spyOn(ctx.storage, 'getStream').mockRejectedValueOnce('boom');
    await expect(ctx.open.execute(request)).rejects.toMatchObject({ appError: { code: 'X0003' } });

    await ctx.storage.delete('fiapx-zips', ZIP_KEY);
    await expect(ctx.open.execute(request)).rejects.toMatchObject({ appError: { code: 'V0006' } });
  });

  it('zipFileName strips the extension', () => {
    expect(zipFileName('demo.mp4')).toBe('demo_frames.zip');
    expect(zipFileName('sem-extensao')).toBe('sem-extensao_frames.zip');
    expect(zipFileName('.mp4')).toBe('.mp4_frames.zip');
    expect(zipFileName('')).toBe('video_frames.zip');
  });
});
