import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  ObjectNotFoundError,
  ObjectStorageError,
  StorageQuotaExceededError,
} from './object-storage.port';
import { createS3Client, isNotFound, isQuotaExceeded, S3ObjectStorage } from './s3-object-storage';

const options = {
  endpoint: 'http://garage:3900',
  region: 'garage',
  accessKeyId: 'GK0123456789abcdef01234567',
  secretAccessKey: 'x'.repeat(64),
  forcePathStyle: true,
};

type Send = (command: unknown) => Promise<unknown>;

function setup() {
  const client = createS3Client(options);
  const send = jest.spyOn(client, 'send') as unknown as jest.MockedFunction<Send>;
  return { client, send, storage: new S3ObjectStorage(client, { partSizeBytes: 5 * 1024 * 1024 }) };
}

function serviceError(name: string, status: number): S3ServiceException {
  return new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: status } });
}

describe('createS3Client', () => {
  it('configura endpoint, região, path-style, credenciais e checksums só quando obrigatórios', async () => {
    const client = createS3Client(options);

    expect(await client.config.region()).toBe('garage');
    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.credentials()).toMatchObject({ accessKeyId: options.accessKeyId });
    expect(await client.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
    expect(await client.config.responseChecksumValidation()).toBe('WHEN_REQUIRED');
    expect(await client.config.maxAttempts()).toBe(3);
    const endpoint = await client.config.endpoint?.();
    expect(endpoint).toMatchObject({ hostname: 'garage', port: 3900, protocol: 'http:' });
    client.destroy();
  });

  it('aceita tentativas customizadas', async () => {
    const client = createS3Client({ ...options, maxAttempts: 5, requestTimeoutMs: 1_000 });
    expect(await client.config.maxAttempts()).toBe(5);
    client.destroy();
  });
});

describe('S3ObjectStorage', () => {
  describe('putStream', () => {
    it('Buffer: PutObject com content-type e metadados, devolve tamanho e ETag', async () => {
      const { send, storage } = setup();
      send.mockResolvedValue({ ETag: '"abc"', $metadata: {} });

      const result = await storage.putStream({
        bucket: 'fiapx-zips',
        key: 'u/v.zip',
        body: Buffer.from('zip!'),
        contentType: 'application/zip',
        metadata: { 'video-id': 'v', 'frame-count': '3' },
      });

      expect(result).toEqual({ sizeBytes: 4, etag: '"abc"' });
      const command = send.mock.calls[0]?.[0] as PutObjectCommand;
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({
        Bucket: 'fiapx-zips',
        Key: 'u/v.zip',
        ContentType: 'application/zip',
        Metadata: { 'video-id': 'v', 'frame-count': '3' },
      });
    });

    it('stream: conta os bytes enviados', async () => {
      const { send, storage } = setup();
      send.mockResolvedValue({ ETag: '"e"', $metadata: {} });

      const result = await storage.putStream({
        bucket: 'fiapx-raw',
        key: 'u/v.mp4',
        body: Readable.from([Buffer.from('abc'), Buffer.from('de')]),
      });

      expect(result.sizeBytes).toBe(5);
    });

    it('falha do S3 vira ObjectStorageError com a causa', async () => {
      const { send, storage } = setup();
      const cause = serviceError('InternalError', 500);
      send.mockRejectedValue(cause);

      const error = await storage
        .putStream({ bucket: 'b', key: 'k', body: Buffer.from('x') })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ObjectStorageError);
      expect(error).toMatchObject({ operation: 'put', bucket: 'b', key: 'k' });
    });

    it('quota do bucket estourada (403 do Garage) vira StorageQuotaExceededError', async () => {
      const { send, storage } = setup();
      const cause = new S3ServiceException({
        name: 'AccessDenied',
        $fault: 'client',
        $metadata: { httpStatusCode: 403 },
        message: 'Forbidden: Bucket size quota is reached, maximum total size of objects: 1024',
      });
      send.mockRejectedValue(cause);

      const error = await storage
        .putStream({ bucket: 'fiapx-zips', key: 'u/v.zip', body: Buffer.from('x') })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(StorageQuotaExceededError);
      expect(error).toBeInstanceOf(ObjectStorageError);
      expect(error).toMatchObject({
        name: 'StorageQuotaExceededError',
        operation: 'put',
        bucket: 'fiapx-zips',
        key: 'u/v.zip',
        cause,
      });
    });

    it('erro no stream de origem (cliente desconectou) falha o upload', async () => {
      const { send, storage } = setup();
      send.mockResolvedValue({ $metadata: {} });
      const source = new Readable({
        read() {
          this.destroy(new Error('aborted'));
        },
      });

      await expect(
        storage.putStream({ bucket: 'b', key: 'k', body: source }),
      ).rejects.toBeInstanceOf(ObjectStorageError);
    });

    it('signal já abortado não envia nada', async () => {
      const { send, storage } = setup();
      const controller = new AbortController();
      controller.abort(new Error('cancelado'));

      await expect(
        storage.putStream({
          bucket: 'b',
          key: 'k',
          body: Buffer.from('x'),
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'ObjectStorageError', cause: new Error('cancelado') });
      expect(send).not.toHaveBeenCalled();
    });

    it('abortar durante o upload cancela o envio', async () => {
      const { send, storage } = setup();
      const controller = new AbortController();
      send.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('interrompido')), 20);
          }),
      );

      const pending = storage.putStream({
        bucket: 'b',
        key: 'k',
        body: Buffer.from('x'),
        signal: controller.signal,
      });
      controller.abort();

      await expect(pending).rejects.toBeInstanceOf(ObjectStorageError);
    });
  });

  describe('getStream', () => {
    it('devolve o corpo em stream com os metadados', async () => {
      const { send, storage } = setup();
      const modified = new Date('2026-01-01T00:00:00Z');
      send.mockResolvedValue({
        Body: Readable.from([Buffer.from('zip')]),
        ContentLength: 3,
        ContentType: 'application/zip',
        ETag: '"e"',
        LastModified: modified,
        Metadata: { 'frame-count': '3' },
      });

      const object = await storage.getStream('fiapx-zips', 'u/v.zip');

      expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
      expect(await text(object.body)).toBe('zip');
      expect(object).toMatchObject({
        sizeBytes: 3,
        contentType: 'application/zip',
        etag: '"e"',
        lastModified: modified,
        metadata: { 'frame-count': '3' },
      });
    });

    it('NoSuchKey vira ObjectNotFoundError', async () => {
      const { send, storage } = setup();
      send.mockRejectedValue(new NoSuchKey({ message: 'x', $metadata: { httpStatusCode: 404 } }));
      await expect(storage.getStream('b', 'k')).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('corpo que não é stream Node vira ObjectStorageError', async () => {
      const { send, storage } = setup();
      send.mockResolvedValue({ Body: 'texto' });
      await expect(storage.getStream('b', 'k')).rejects.toMatchObject({
        name: 'ObjectStorageError',
        operation: 'get',
      });
    });
  });

  describe('head / exists', () => {
    it('head devolve metadados (sem campos opcionais ausentes)', async () => {
      const { send, storage } = setup();
      send.mockResolvedValue({});

      expect(await storage.head('b', 'k')).toEqual({
        sizeBytes: 0,
        contentType: undefined,
        etag: undefined,
        lastModified: undefined,
        metadata: {},
      });
      expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    });

    it('NotFound (404 do HEAD) vira ObjectNotFoundError; exists devolve false', async () => {
      const { send, storage } = setup();
      send.mockRejectedValue(new NotFound({ message: 'x', $metadata: { httpStatusCode: 404 } }));

      await expect(storage.head('b', 'k')).rejects.toBeInstanceOf(ObjectNotFoundError);
      expect(await storage.exists('b', 'k')).toBe(false);
    });

    it('exists devolve true quando o HEAD responde', async () => {
      const { send, storage } = setup();
      send.mockResolvedValue({ ContentLength: 1 });
      expect(await storage.exists('b', 'k')).toBe(true);
    });

    it('erro que não é 404 propaga como ObjectStorageError (NotFound ≠ erro)', async () => {
      const { send, storage } = setup();
      send.mockRejectedValue(serviceError('ServiceUnavailable', 503));

      await expect(storage.head('b', 'k')).rejects.toBeInstanceOf(ObjectStorageError);
      await expect(storage.exists('b', 'k')).rejects.toBeInstanceOf(ObjectStorageError);
    });
  });

  describe('delete / checkBucket', () => {
    it('delete envia DeleteObject e converte falhas', async () => {
      const { send, storage } = setup();
      send.mockResolvedValueOnce({});
      await storage.delete('b', 'k');
      expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand);

      send.mockRejectedValueOnce(new Error('rede'));
      await expect(storage.delete('b', 'k')).rejects.toMatchObject({ operation: 'delete' });
    });

    it('checkBucket envia HeadBucket e converte falhas (inclusive bucket inexistente)', async () => {
      const { send, storage } = setup();
      send.mockResolvedValueOnce({});
      await storage.checkBucket('fiapx-raw');
      expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);

      send.mockRejectedValueOnce(serviceError('NotFound', 404));
      await expect(storage.checkBucket('nao-existe')).rejects.toMatchObject({
        name: 'ObjectStorageError',
        operation: 'checkBucket',
      });
    });
  });

  it('usa partes de 8 MiB e 2 em paralelo por padrão', () => {
    const storage = new S3ObjectStorage({} as S3Client);
    expect(storage).toMatchObject({ partSize: 8 * 1024 * 1024, queueSize: 2 });
  });
});

describe('isQuotaExceeded', () => {
  it.each([
    [new Error('Bucket size quota is reached'), true],
    [{ Code: 'QuotaExceeded' }, true],
    [new Error('upload falhou', { cause: new Error('bucket quota reached') }), true],
    [new Error('The request signature we calculated does not match'), false],
    [{ message: 42 }, false],
    [null, false],
    ['quota', false],
  ])('%p → %p', (error, expected) => {
    expect(isQuotaExceeded(error)).toBe(expected);
  });

  it('não desce mais que 3 níveis de cause', () => {
    let error: unknown = new Error('quota');
    for (let i = 0; i < 4; i += 1) error = { cause: error };
    expect(isQuotaExceeded(error)).toBe(false);
  });
});

describe('isNotFound', () => {
  it.each([
    [{ name: 'NoSuchKey' }, true],
    [{ name: 'NotFound' }, true],
    [{ name: 'X', $metadata: { httpStatusCode: 404 } }, true],
    [{ name: 'X', $metadata: { httpStatusCode: 500 } }, false],
    [{ name: 'X' }, false],
    [null, false],
    ['NotFound', false],
  ])('%p → %p', (error, expected) => {
    expect(isNotFound(error)).toBe(expected);
  });
});
