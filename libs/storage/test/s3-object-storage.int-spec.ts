import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer, text } from 'node:stream/consumers';
import type { StartedGarage } from '@fiapx/testing';
import { startGarage } from '@fiapx/testing';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  createS3Client,
  ObjectNotFoundError,
  ObjectStorageError,
  rawVideoKey,
  S3ObjectStorage,
  zipKey,
} from '../src';

/**
 * Integração com Garage REAL (mesma imagem, `garage.toml` e `init.mjs` do compose, via
 * Testcontainers): buckets `fiapx-raw` e `fiapx-zips` e chave S3 aleatória por execução.
 */
describe('S3ObjectStorage com Garage real', () => {
  let garage: StartedGarage;
  let client: S3Client;
  let storage: S3ObjectStorage;
  const userId = randomUUID();

  beforeAll(async () => {
    garage = await startGarage();
    client = createS3Client({
      endpoint: garage.endpoint,
      region: garage.region,
      accessKeyId: garage.accessKeyId,
      secretAccessKey: garage.secretAccessKey,
      forcePathStyle: true,
    });
    // Parte mínima do S3 (5 MiB): um arquivo de 12 MiB vira upload multipart de 3 partes.
    storage = new S3ObjectStorage(client, { partSizeBytes: 5 * 1024 * 1024, queueSize: 2 });
  }, 180_000);

  afterAll(async () => {
    client?.destroy();
    await garage?.stop();
  });

  it('os buckets do contrato existem e as credenciais valem (readiness)', async () => {
    await expect(storage.checkBucket(garage.buckets.raw)).resolves.toBeUndefined();
    await expect(storage.checkBucket(garage.buckets.zips)).resolves.toBeUndefined();
    await expect(storage.checkBucket('bucket-que-nao-existe')).rejects.toBeInstanceOf(
      ObjectStorageError,
    );
  });

  it('putStream em multipart (stream de 12 MiB) e getStream devolvem o mesmo conteúdo', async () => {
    const videoId = randomUUID();
    const key = rawVideoKey(userId, videoId, '.mp4');
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const source = Readable.from(
      Array.from({ length: 12 }, (_v, i) => Buffer.from(chunk.map((b) => b + i))),
    );

    const result = await storage.putStream({
      bucket: garage.buckets.raw,
      key,
      body: source,
      contentType: 'video/mp4',
    });

    expect(result.sizeBytes).toBe(12 * 1024 * 1024);
    expect(result.etag).toMatch(/-3"?$/); // ETag de multipart: "<md5>-<partes>"
    const object = await storage.getStream(garage.buckets.raw, key);
    expect(object.sizeBytes).toBe(12 * 1024 * 1024);
    expect(object.contentType).toBe('video/mp4');
    const downloaded = await buffer(object.body);
    expect(downloaded.length).toBe(12 * 1024 * 1024);
    expect(downloaded[5 * 1024 * 1024]).toBe(7 + 5);
  });

  it('zip com metadados x-amz-meta-* (video-id, frame-count) e HEAD idempotente do worker', async () => {
    const videoId = randomUUID();
    const key = zipKey(userId, videoId);
    expect(await storage.exists(garage.buckets.zips, key)).toBe(false);

    await storage.putStream({
      bucket: garage.buckets.zips,
      key,
      body: Buffer.from('PK zip de teste'),
      contentType: 'application/zip',
      metadata: { 'video-id': videoId, 'frame-count': '3' },
    });

    expect(await storage.exists(garage.buckets.zips, key)).toBe(true);
    const head = await storage.head(garage.buckets.zips, key);
    expect(head).toMatchObject({
      sizeBytes: 15,
      contentType: 'application/zip',
      metadata: { 'video-id': videoId, 'frame-count': '3' },
    });
    expect(head.lastModified).toBeInstanceOf(Date);
    expect(await text((await storage.getStream(garage.buckets.zips, key)).body)).toBe(
      'PK zip de teste',
    );
  });

  it('objeto inexistente: HEAD e GET lançam ObjectNotFoundError (não erro genérico)', async () => {
    const key = zipKey(userId, randomUUID());
    await expect(storage.head(garage.buckets.zips, key)).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    await expect(storage.getStream(garage.buckets.zips, key)).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it('delete é idempotente', async () => {
    const key = zipKey(userId, randomUUID());
    await storage.putStream({ bucket: garage.buckets.zips, key, body: Buffer.from('x') });

    await storage.delete(garage.buckets.zips, key);
    await storage.delete(garage.buckets.zips, key);

    expect(await storage.exists(garage.buckets.zips, key)).toBe(false);
  });

  it('credenciais erradas viram ObjectStorageError (e não "não encontrado")', async () => {
    const wrong = createS3Client({
      endpoint: garage.endpoint,
      region: garage.region,
      accessKeyId: garage.accessKeyId,
      secretAccessKey: 'f'.repeat(64),
      forcePathStyle: true,
      maxAttempts: 1,
    });
    const other = new S3ObjectStorage(wrong);
    try {
      await expect(other.head(garage.buckets.zips, 'qualquer')).rejects.toBeInstanceOf(
        ObjectStorageError,
      );
    } finally {
      wrong.destroy();
    }
  });
});
