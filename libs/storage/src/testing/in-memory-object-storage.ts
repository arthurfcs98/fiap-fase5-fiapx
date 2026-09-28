import { Readable } from 'node:stream';
import type { IObjectStorage, ObjectMetadata, PutObjectInput } from '../object-storage.port';
import { ObjectNotFoundError } from '../object-storage.port';

interface StoredObject {
  body: Buffer;
  contentType?: string;
  metadata: Record<string, string>;
}

/**
 * Implementação em memória da porta de storage, para testes unitários de casos de uso
 * (api e worker) sem Garage. Não usar em produção.
 */
export class InMemoryObjectStorage implements IObjectStorage {
  private readonly objects = new Map<string, StoredObject>();

  async putObject(input: PutObjectInput): Promise<void> {
    const body = Buffer.isBuffer(input.body) ? input.body : await toBuffer(input.body);
    this.objects.set(id(input.bucket, input.key), {
      body,
      contentType: input.contentType,
      metadata: { ...input.metadata },
    });
  }

  getObjectStream(bucket: string, key: string): Promise<Readable> {
    const object = this.objects.get(id(bucket, key));
    if (!object) return Promise.reject(new ObjectNotFoundError(bucket, key));
    return Promise.resolve(Readable.from([object.body]));
  }

  headObject(bucket: string, key: string): Promise<ObjectMetadata | null> {
    const object = this.objects.get(id(bucket, key));
    if (!object) return Promise.resolve(null);
    return Promise.resolve({
      sizeBytes: object.body.length,
      contentType: object.contentType,
      metadata: { ...object.metadata },
    });
  }

  deleteObject(bucket: string, key: string): Promise<void> {
    this.objects.delete(id(bucket, key));
    return Promise.resolve();
  }

  /** Quantidade de objetos armazenados (para asserções). */
  get size(): number {
    return this.objects.size;
  }
}

function id(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
