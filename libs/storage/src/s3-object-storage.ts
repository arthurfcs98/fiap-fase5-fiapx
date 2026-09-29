import { pipeline, Readable, Transform } from 'node:stream';
import type { S3ServiceException } from '@aws-sdk/client-s3';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type {
  IObjectStorage,
  ObjectMetadata,
  ObjectStorageOperation,
  ObjectStream,
  PutResult,
  PutStreamInput,
} from './object-storage.port';
import { ObjectNotFoundError, ObjectStorageError } from './object-storage.port';

export interface S3ClientOptions {
  /** `S3_ENDPOINT` (ex.: `http://garage:3900`). */
  endpoint: string;
  /** `S3_REGION` (Garage: `garage`). */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `S3_FORCE_PATH_STYLE` (Garage local: `true`). */
  forcePathStyle: boolean;
  /** Timeout por requisição HTTP. Padrão: 30 s. */
  requestTimeoutMs?: number;
  /** Tentativas do SDK por operação (retry interno com backoff). Padrão: 3. */
  maxAttempts?: number;
}

/**
 * Cliente S3 para o Garage (contratos.md, seção 7): `forcePathStyle`, região `garage` e
 * checksums só quando obrigatórios (os checksums CRC padrão das versões recentes do SDK não são
 * necessários com o Garage e atrapalham uploads em stream de tamanho desconhecido).
 */
export function createS3Client(options: S3ClientOptions): S3Client {
  return new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    maxAttempts: options.maxAttempts ?? 3,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      requestTimeout: options.requestTimeoutMs ?? 30_000,
      connectionTimeout: 5_000,
    },
  });
}

export interface S3ObjectStorageOptions {
  /** Tamanho de cada parte do multipart (mín. 5 MiB no S3). Padrão: 8 MiB. */
  partSizeBytes?: number;
  /** Partes enviadas em paralelo por upload. Padrão: 2 (memória ≈ partSize × queueSize). */
  queueSize?: number;
}

const MIB = 1024 * 1024;

/** Adaptador S3/Garage da porta {@link IObjectStorage}. */
export class S3ObjectStorage implements IObjectStorage {
  private readonly partSize: number;
  private readonly queueSize: number;

  constructor(
    private readonly client: S3Client,
    options: S3ObjectStorageOptions = {},
  ) {
    this.partSize = options.partSizeBytes ?? 8 * MIB;
    this.queueSize = options.queueSize ?? 2;
  }

  async putStream(input: PutStreamInput): Promise<PutResult> {
    const { bucket, key } = input;
    let sizeBytes = 0;
    let body: Readable | Buffer = input.body;
    if (Buffer.isBuffer(input.body)) {
      sizeBytes = input.body.length;
    } else {
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          callback(null, chunk);
        },
      });
      // pipeline propaga o erro da origem (ex.: cliente desconectou) para o Upload.
      pipeline(input.body, counter, () => undefined);
      body = counter;
    }

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: input.contentType,
        Metadata: input.metadata,
      },
      partSize: this.partSize,
      queueSize: this.queueSize,
      leavePartsOnError: false,
    });
    const onAbort = () => {
      void upload.abort().catch(() => undefined);
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (input.signal?.aborted) throw input.signal.reason;
      const output = await upload.done();
      return { sizeBytes, etag: output.ETag };
    } catch (error) {
      throw new ObjectStorageError('put', bucket, key, { cause: error });
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  async getStream(bucket: string, key: string): Promise<ObjectStream> {
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!(output.Body instanceof Readable)) {
        throw new Error('corpo da resposta não é um stream Node.js');
      }
      return {
        body: output.Body,
        ...toMetadata(output),
      };
    } catch (error) {
      throw toStorageError('get', bucket, key, error);
    }
  }

  async head(bucket: string, key: string): Promise<ObjectMetadata> {
    try {
      const output = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return toMetadata(output);
    } catch (error) {
      throw toStorageError('head', bucket, key, error);
    }
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

  async delete(bucket: string, key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      throw new ObjectStorageError('delete', bucket, key, { cause: error });
    }
  }

  async checkBucket(bucket: string): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      throw new ObjectStorageError('checkBucket', bucket, undefined, { cause: error });
    }
  }
}

interface S3ObjectOutput {
  ContentLength?: number;
  ContentType?: string;
  ETag?: string;
  LastModified?: Date;
  Metadata?: Record<string, string>;
}

function toMetadata(output: S3ObjectOutput): ObjectMetadata {
  return {
    sizeBytes: output.ContentLength ?? 0,
    contentType: output.ContentType,
    etag: output.ETag,
    lastModified: output.LastModified,
    metadata: { ...output.Metadata },
  };
}

/** 404 (`NoSuchKey` no GET, `NotFound` no HEAD) → {@link ObjectNotFoundError}; resto → erro de infra. */
function toStorageError(
  operation: ObjectStorageOperation,
  bucket: string,
  key: string,
  error: unknown,
): Error {
  if (isNotFound(error)) return new ObjectNotFoundError(bucket, key);
  return new ObjectStorageError(operation, bucket, key, { cause: error });
}

export function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Partial<S3ServiceException>;
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
