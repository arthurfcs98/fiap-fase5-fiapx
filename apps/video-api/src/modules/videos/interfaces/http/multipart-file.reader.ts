import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { CommonErrors, VideoErrors } from '@fiapx/common';
import busboy from 'busboy';
import type { IncomingVideoFile } from '../../application/use-cases/upload-video.use-case';

/** Multipart field of the video (contratos.md, section 8). */
export const VIDEO_FIELD = 'video';

/** Room for the multipart boundaries and part headers on top of the file itself. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export interface MultipartLimits {
  maxBytes: number;
  maxMb: number;
}

export interface MultipartFileContext {
  file: IncomingVideoFile;
  /** Aborted when the client disconnects or the size limit is exceeded. */
  signal: AbortSignal;
}

/** Pushed into the file stream when the size limit is exceeded (answered as 413 V0003). */
export class FileTooLargeError extends Error {
  constructor() {
    super('File exceeds MAX_UPLOAD_MB');
    this.name = 'FileTooLargeError';
  }
}

/**
 * Reads ONE file (field `video`) from a `multipart/form-data` request with busboy and hands it to
 * `handle` as a stream while it is still arriving: the body never touches the disk or the heap.
 *
 * - more than `MAX_UPLOAD_MB` → the stream fails and the storage upload aborts → `413 V0003`;
 * - no `video` file or a body that is not multipart → `400 X0001`;
 * - other fields and any extra file are ignored (one video per request);
 * - `handle` rejects early (e.g. wrong format) → the rest of the body is drained, so the client
 *   can finish sending and read the error instead of a reset connection;
 * - the client disconnects → the signal aborts the storage upload.
 */
export function readMultipartFile<T>(
  req: IncomingMessage,
  limits: MultipartLimits,
  handle: (context: MultipartFileContext) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: { files: 5, fileSize: limits.maxBytes, fields: 10, fieldSize: 1024, parts: 20 },
      });
    } catch {
      const error = invalid('Envie o vídeo como multipart/form-data no campo "video".');
      void drainRequest(req).then(() => reject(error));
      return;
    }

    const controller = new AbortController();
    let handler: Promise<T> | undefined;
    let fileStream: PassThrough | undefined;
    let tooLarge = false;
    let parserError: unknown;
    let settled = false;

    const finish = (outcome: { value: T } | { error: Error }) => {
      if (settled) return;
      settled = true;
      req.off('close', onClose);
      if ('value' in outcome) {
        resolve(outcome.value);
        return;
      }
      if (!controller.signal.aborted) controller.abort(outcome.error);
      fileStream?.destroy();
      req.unpipe(parser);
      const error = tooLarge
        ? VideoErrors.FILE_TOO_LARGE(limits.maxMb)
        : parserError !== undefined
          ? invalid(`Multipart inválido: ${describe(parserError)}`)
          : outcome.error;
      // Answer only after the body is drained: a client still sending would otherwise get
      // EPIPE/ECONNRESET instead of the error response.
      void drainRequest(req).then(() => reject(error));
    };

    // `close` before the whole body arrived = the client disconnected mid-upload.
    const onClose = () => {
      if (!req.complete) finish({ error: new Error('Cliente encerrou a conexão no upload') });
    };
    req.once('close', onClose);

    const parsed = new Promise<void>((done, failed) => {
      parser.once('close', () => done());
      parser.on('error', (error: unknown) => {
        parserError ??= error;
        failed(asError(error));
      });
    });

    parser.on('file', (name, stream, info) => {
      if (name !== VIDEO_FIELD || handler) {
        stream.resume();
        return;
      }
      const out = new PassThrough();
      fileStream = out;
      // Errors reach the consumer (storage upload) through its own listeners; this one only keeps
      // an unconsumed stream (handler already rejected) from crashing the process.
      out.on('error', () => undefined);
      stream.once('error', (error: Error) => out.destroy(error));
      stream.once('limit', () => {
        tooLarge = true;
        const error = new FileTooLargeError();
        controller.abort(error);
        stream.unpipe(out);
        stream.resume();
        out.destroy(error);
      });
      stream.pipe(out);
      handler = handle({
        file: { originalName: info.filename ?? '', stream: out },
        signal: controller.signal,
      });
      Promise.all([handler, parsed]).then(
        ([value]) => finish({ value }),
        (error: unknown) => finish({ error: asError(error) }),
      );
    });

    parsed.then(
      () => {
        if (!handler) finish({ error: invalid('Envie o arquivo de vídeo no campo "video".') });
      },
      (error: unknown) => {
        if (!handler) finish({ error: asError(error) });
      },
    );

    req.pipe(parser);
  });
}

/**
 * Reads and discards the rest of the body; resolves when it is over (or the client left), so the
 * error response goes to a client able to read it. Bounded by the proxy body limit
 * (Cloudflare/ingress) and Node's `requestTimeout`.
 */
export function drainRequest(req: IncomingMessage): Promise<void> {
  if (req.readableEnded || req.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      req.off('end', done);
      req.off('close', done);
      req.off('error', done);
      resolve();
    };
    req.on('end', done);
    req.on('close', done);
    req.on('error', done);
    req.resume();
  });
}

function invalid(message: string) {
  return CommonErrors.VALIDATION([{ field: VIDEO_FIELD, message }]);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
