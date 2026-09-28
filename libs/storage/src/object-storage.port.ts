import type { Readable } from 'node:stream';

/** Token de injeção da porta de storage (adapter S3/Garage entra na E3). */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface ObjectMetadata {
  sizeBytes: number;
  contentType?: string;
  /** Metadados `x-amz-meta-*` (ex.: `round`, `frame-count`). */
  metadata: Record<string, string>;
}

export interface PutObjectInput {
  bucket: string;
  key: string;
  body: Readable | Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
}

/** Porta (Clean Architecture) para object storage S3-compatível. */
export interface IObjectStorage {
  putObject(input: PutObjectInput): Promise<void>;
  /** Lança {@link ObjectNotFoundError} se o objeto não existir. */
  getObjectStream(bucket: string, key: string): Promise<Readable>;
  /** `null` quando o objeto não existe (qualquer outro erro é propagado). */
  headObject(bucket: string, key: string): Promise<ObjectMetadata | null>;
  deleteObject(bucket: string, key: string): Promise<void>;
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
