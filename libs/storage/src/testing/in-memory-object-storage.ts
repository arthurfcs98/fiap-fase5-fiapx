import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  IObjectStorage,
  ObjectMetadata,
  ObjectStorageOperation,
  ObjectStream,
  PutResult,
  PutStreamInput,
} from '../object-storage.port';
import { ObjectNotFoundError, ObjectStorageError } from '../object-storage.port';

interface StoredObject {
  body: Buffer;
  contentType?: string;
  metadata: Record<string, string>;
  lastModified: Date;
}

/**
 * Implementação em memória da porta de storage, para testes unitários de casos de uso
 * (api e worker) sem Garage. Não usar em produção.
 *
 * `failNext(operation)` simula uma falha de infraestrutura ({@link ObjectStorageError}) na
 * próxima chamada daquela operação. Passando um `ObjectStorageError` pronto (ex.:
 * `StorageQuotaExceededError`), ele é lançado como está.
 */
export class InMemoryObjectStorage implements IObjectStorage {
  private readonly objects = new Map<string, StoredObject>();
  private readonly failures = new Map<ObjectStorageOperation, unknown>();
  readonly buckets = new Set<string>(['fiapx-raw', 'fiapx-zips']);

  failNext(operation: ObjectStorageOperation, cause: unknown = new Error('falha simulada')): this {
    this.failures.set(operation, cause);
    return this;
  }

  async putStream(input: PutStreamInput): Promise<PutResult> {
    this.maybeFail('put', input.bucket, input.key);
    if (input.signal?.aborted) {
      throw new ObjectStorageError('put', input.bucket, input.key, {
        cause: input.signal.reason,
      });
    }
    const body = Buffer.isBuffer(input.body) ? input.body : await toBuffer(input.body);
    this.objects.set(id(input.bucket, input.key), {
      body,
      contentType: input.contentType,
      metadata: lowerKeys(input.metadata),
      lastModified: new Date(),
    });
    return { sizeBytes: body.length, etag: etag(body) };
  }

  getStream(bucket: string, key: string): Promise<ObjectStream> {
    return this.run('get', bucket, key, (object) => ({
      ...describe(object),
      body: Readable.from([object.body]),
    }));
  }

  head(bucket: string, key: string): Promise<ObjectMetadata> {
    return this.run('head', bucket, key, describe);
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.head(bucket, key);
      return true;
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return false;
      throw error;
    }
  }

  delete(bucket: string, key: string): Promise<void> {
    return attempt(() => {
      this.maybeFail('delete', bucket, key);
      this.objects.delete(id(bucket, key));
    });
  }

  checkBucket(bucket: string): Promise<void> {
    return attempt(() => {
      this.maybeFail('checkBucket', bucket);
      if (!this.buckets.has(bucket)) throw new ObjectStorageError('checkBucket', bucket, undefined);
    });
  }

  /** Quantidade de objetos armazenados (para asserções). */
  get size(): number {
    return this.objects.size;
  }

  /** Conteúdo gravado (para asserções); `undefined` se não existir. */
  contentOf(bucket: string, key: string): Buffer | undefined {
    return this.objects.get(id(bucket, key))?.body;
  }

  private run<T>(
    operation: ObjectStorageOperation,
    bucket: string,
    key: string,
    map: (object: StoredObject) => T,
  ): Promise<T> {
    return attempt(() => {
      this.maybeFail(operation, bucket, key);
      const object = this.objects.get(id(bucket, key));
      if (!object) throw new ObjectNotFoundError(bucket, key);
      return map(object);
    });
  }

  private maybeFail(operation: ObjectStorageOperation, bucket: string, key?: string): void {
    if (!this.failures.has(operation)) return;
    const cause = this.failures.get(operation);
    this.failures.delete(operation);
    if (cause instanceof ObjectStorageError) throw cause;
    throw new ObjectStorageError(operation, bucket, key, { cause });
  }
}

/** Executa `fn` como uma operação assíncrona: exceção vira promessa rejeitada. */
function attempt<T>(fn: () => T): Promise<T> {
  return new Promise<T>((resolve) => resolve(fn()));
}

function describe(object: StoredObject): ObjectMetadata {
  return {
    sizeBytes: object.body.length,
    contentType: object.contentType,
    etag: etag(object.body),
    lastModified: object.lastModified,
    metadata: { ...object.metadata },
  };
}

function etag(body: Buffer): string {
  return `"${createHash('md5').update(body).digest('hex')}"`;
}

function lowerKeys(metadata: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k.toLowerCase(), v]));
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
