import type { Readable } from 'node:stream';

/** Token de injeção da porta de storage (`@Inject(OBJECT_STORAGE) storage: IObjectStorage`). */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface ObjectMetadata {
  sizeBytes: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
  /** Metadados `x-amz-meta-*` sem o prefixo, em minúsculas (ex.: `video-id`, `frame-count`). */
  metadata: Record<string, string>;
}

export interface PutStreamInput {
  bucket: string;
  key: string;
  /** Stream (upload multipart em partes, sem carregar o arquivo em memória) ou Buffer. */
  body: Readable | Buffer;
  contentType?: string;
  /** Viram `x-amz-meta-<chave>` (chaves em minúsculas, valores ASCII). */
  metadata?: Record<string, string>;
  /** Aborta o upload (ex.: cliente HTTP desconectou): partes enviadas são descartadas. */
  signal?: AbortSignal;
}

export interface PutResult {
  /** Bytes gravados (contados no stream). */
  sizeBytes: number;
  etag?: string;
}

export interface ObjectStream extends ObjectMetadata {
  body: Readable;
}

/**
 * Porta (Clean Architecture) para object storage S3-compatível (Garage).
 *
 * Erros: objeto inexistente → {@link ObjectNotFoundError}; qualquer outra falha (rede, 5xx,
 * credencial) → {@link ObjectStorageError} com a causa. O worker trata `ObjectStorageError` como
 * transitório (`RetryableError`) e `ObjectNotFoundError` como `P0005 SOURCE_NOT_FOUND`.
 */
export interface IObjectStorage {
  /** Grava em streaming (multipart). Sobrescreve se a chave já existir. */
  putStream(input: PutStreamInput): Promise<PutResult>;
  /** @throws ObjectNotFoundError */
  getStream(bucket: string, key: string): Promise<ObjectStream>;
  /** @throws ObjectNotFoundError */
  head(bucket: string, key: string): Promise<ObjectMetadata>;
  /** `false` só quando o objeto não existe; outros erros propagam. */
  exists(bucket: string, key: string): Promise<boolean>;
  /** Idempotente: apagar o que não existe não é erro. */
  delete(bucket: string, key: string): Promise<void>;
  /** Readiness: confirma que o bucket existe e as credenciais valem. */
  checkBucket(bucket: string): Promise<void>;
}

export class ObjectNotFoundError extends Error {
  constructor(
    public readonly bucket: string,
    public readonly key: string,
  ) {
    super(`Objeto não encontrado: ${bucket}/${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

export type ObjectStorageOperation = 'put' | 'get' | 'head' | 'delete' | 'checkBucket';

/** Falha do storage que não é "objeto inexistente" (rede, timeout, 5xx, permissão). */
export class ObjectStorageError extends Error {
  constructor(
    public readonly operation: ObjectStorageOperation,
    public readonly bucket: string,
    public readonly key: string | undefined,
    options?: { cause?: unknown },
  ) {
    const target = key === undefined ? bucket : `${bucket}/${key}`;
    const reason = options?.cause instanceof Error ? `: ${options.cause.message}` : '';
    super(`Falha no storage (${operation} ${target})${reason}`, options);
    this.name = 'ObjectStorageError';
  }
}
