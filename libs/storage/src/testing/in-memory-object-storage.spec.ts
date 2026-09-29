import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import {
  ObjectNotFoundError,
  ObjectStorageError,
  StorageQuotaExceededError,
} from '../object-storage.port';
import { InMemoryObjectStorage } from './in-memory-object-storage';

describe('InMemoryObjectStorage', () => {
  it('grava de Buffer e lê de volta com metadados (chaves em minúsculas, como o S3)', async () => {
    const storage = new InMemoryObjectStorage();
    const result = await storage.putStream({
      bucket: 'fiapx-zips',
      key: 'u/v.zip',
      body: Buffer.from('zip!'),
      contentType: 'application/zip',
      metadata: { 'Video-Id': 'v', 'frame-count': '3' },
    });

    expect(result).toEqual({ sizeBytes: 4, etag: expect.stringMatching(/^"[0-9a-f]{32}"$/) });
    expect(await storage.head('fiapx-zips', 'u/v.zip')).toMatchObject({
      sizeBytes: 4,
      contentType: 'application/zip',
      etag: result.etag,
      lastModified: expect.any(Date),
      metadata: { 'video-id': 'v', 'frame-count': '3' },
    });
    const object = await storage.getStream('fiapx-zips', 'u/v.zip');
    expect(await text(object.body)).toBe('zip!');
    expect(object.sizeBytes).toBe(4);
    expect(storage.size).toBe(1);
    expect(storage.contentOf('fiapx-zips', 'u/v.zip')?.toString()).toBe('zip!');
    expect(storage.contentOf('fiapx-zips', 'nada')).toBeUndefined();
  });

  it('grava a partir de stream (Buffer e string)', async () => {
    const storage = new InMemoryObjectStorage();
    const result = await storage.putStream({
      bucket: 'fiapx-raw',
      key: 'u/v.mp4',
      body: Readable.from([Buffer.from('ab'), 'cd']),
    });
    expect(result.sizeBytes).toBe(4);
    expect(await storage.head('fiapx-raw', 'u/v.mp4')).toMatchObject({
      sizeBytes: 4,
      contentType: undefined,
      metadata: {},
    });
  });

  it('objeto inexistente: head/get lançam ObjectNotFoundError e exists devolve false', async () => {
    const storage = new InMemoryObjectStorage();
    await expect(storage.head('b', 'k')).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(storage.getStream('b', 'k')).rejects.toThrow('Objeto não encontrado: b/k');
    expect(await storage.exists('b', 'k')).toBe(false);
  });

  it('exists devolve true para objeto gravado', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putStream({ bucket: 'b', key: 'k', body: Buffer.from('x') });
    expect(await storage.exists('b', 'k')).toBe(true);
  });

  it('remove objetos (idempotente)', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putStream({ bucket: 'b', key: 'k', body: Buffer.from('x') });
    await storage.delete('b', 'k');
    await storage.delete('b', 'k');
    expect(storage.size).toBe(0);
  });

  it('não expõe o objeto interno de metadados', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putStream({
      bucket: 'b',
      key: 'k',
      body: Buffer.from('x'),
      metadata: { a: '1' },
    });
    const head = await storage.head('b', 'k');
    head.metadata['a'] = 'alterado';
    expect((await storage.head('b', 'k')).metadata['a']).toBe('1');
  });

  it('checkBucket conhece os buckets do FIAP X', async () => {
    const storage = new InMemoryObjectStorage();
    await expect(storage.checkBucket('fiapx-raw')).resolves.toBeUndefined();
    await expect(storage.checkBucket('outro')).rejects.toBeInstanceOf(ObjectStorageError);
  });

  it('upload já abortado falha sem gravar', async () => {
    const storage = new InMemoryObjectStorage();
    const controller = new AbortController();
    controller.abort(new Error('cliente desconectou'));

    await expect(
      storage.putStream({
        bucket: 'b',
        key: 'k',
        body: Buffer.from('x'),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ObjectStorageError);
    expect(storage.size).toBe(0);
  });

  it.each([
    [
      'put',
      (s: InMemoryObjectStorage) => s.putStream({ bucket: 'b', key: 'k', body: Buffer.from('x') }),
    ],
    ['get', (s: InMemoryObjectStorage) => s.getStream('b', 'k')],
    ['head', (s: InMemoryObjectStorage) => s.head('b', 'k')],
    ['head', (s: InMemoryObjectStorage) => s.exists('b', 'k')],
    ['delete', (s: InMemoryObjectStorage) => s.delete('b', 'k')],
    ['checkBucket', (s: InMemoryObjectStorage) => s.checkBucket('fiapx-raw')],
  ] as const)(
    'failNext(%s) simula falha de infraestrutura uma única vez',
    async (operation, act) => {
      const storage = new InMemoryObjectStorage();
      await storage.putStream({ bucket: 'b', key: 'k', body: Buffer.from('x') });
      storage.failNext(operation);

      await expect(act(storage)).rejects.toMatchObject({ name: 'ObjectStorageError', operation });
      await act(storage); // a falha simulada vale para UMA chamada
    },
  );

  it('failNext com um ObjectStorageError pronto (ex.: quota) lança ele mesmo', async () => {
    const storage = new InMemoryObjectStorage();
    const quota = new StorageQuotaExceededError('put', 'fiapx-zips', 'u/v.zip');
    storage.failNext('put', quota);

    await expect(
      storage.putStream({ bucket: 'fiapx-zips', key: 'u/v.zip', body: Buffer.from('x') }),
    ).rejects.toBe(quota);
  });
});
