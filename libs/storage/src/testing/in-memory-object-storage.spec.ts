import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { InMemoryObjectStorage } from './in-memory-object-storage';
import { ObjectNotFoundError } from '../object-storage.port';

describe('InMemoryObjectStorage', () => {
  it('grava de Buffer e lê de volta com metadados', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putObject({
      bucket: 'fiapx-zips',
      key: 'u/v.zip',
      body: Buffer.from('zip!'),
      contentType: 'application/zip',
      metadata: { round: '1' },
    });

    expect(await storage.headObject('fiapx-zips', 'u/v.zip')).toEqual({
      sizeBytes: 4,
      contentType: 'application/zip',
      metadata: { round: '1' },
    });
    expect(await text(await storage.getObjectStream('fiapx-zips', 'u/v.zip'))).toBe('zip!');
    expect(storage.size).toBe(1);
  });

  it('grava a partir de stream (Buffer e string)', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putObject({
      bucket: 'fiapx-raw',
      key: 'u/v.mp4',
      body: Readable.from([Buffer.from('ab'), 'cd']),
    });
    const head = await storage.headObject('fiapx-raw', 'u/v.mp4');
    expect(head).toEqual({ sizeBytes: 4, contentType: undefined, metadata: {} });
  });

  it('head retorna null e get lança ObjectNotFoundError para objeto inexistente', async () => {
    const storage = new InMemoryObjectStorage();
    expect(await storage.headObject('b', 'k')).toBeNull();
    await expect(storage.getObjectStream('b', 'k')).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(storage.getObjectStream('b', 'k')).rejects.toThrow('Objeto não encontrado: b/k');
  });

  it('remove objetos (idempotente)', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putObject({ bucket: 'b', key: 'k', body: Buffer.from('x') });
    await storage.deleteObject('b', 'k');
    await storage.deleteObject('b', 'k');
    expect(storage.size).toBe(0);
  });

  it('não expõe o objeto interno de metadados', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putObject({
      bucket: 'b',
      key: 'k',
      body: Buffer.from('x'),
      metadata: { a: '1' },
    });
    const head = await storage.headObject('b', 'k');
    head!.metadata['a'] = 'alterado';
    expect((await storage.headObject('b', 'k'))?.metadata['a']).toBe('1');
  });
});
