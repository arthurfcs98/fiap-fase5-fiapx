import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { AppErrorException, VideoErrors } from '@fiapx/common';
import request from 'supertest';
import type { MultipartFileContext } from './multipart-file.reader';
import { drainRequest, FileTooLargeError, readMultipartFile } from './multipart-file.reader';

type Handler = (context: MultipartFileContext) => Promise<unknown>;

async function consume(context: MultipartFileContext): Promise<{ name: string; bytes: number }> {
  let bytes = 0;
  for await (const chunk of context.file.stream) bytes += (chunk as Buffer).length;
  return { name: context.file.originalName, bytes };
}

function server(handler: Handler, maxBytes = 1024): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    readMultipartFile(req, { maxBytes, maxMb: 1 }, handler).then(
      (value) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      },
      (error: unknown) => {
        const body =
          error instanceof AppErrorException
            ? {
                status: error.appError.httpStatus,
                code: error.appError.code,
                metadata: error.appError.metadata,
              }
            : { status: 500, message: error instanceof Error ? error.message : String(error) };
        res.writeHead(body.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      },
    );
  });
}

describe('readMultipartFile', () => {
  it('streams the "video" file to the handler (UTF-8 file name) and ignores other parts', async () => {
    const res = await request(server(consume))
      .post('/')
      .field('note', 'ignored')
      .attach('other', Buffer.from('xx'), 'other.bin')
      .attach('video', Buffer.alloc(600, 1), 'férias.mp4')
      .attach('video', Buffer.alloc(10), 'second.mp4')
      .expect(200);
    expect(res.body).toEqual({ name: 'férias.mp4', bytes: 600 });
  });

  it('file over the limit → 413 V0003 and the handler sees the abort', async () => {
    let aborted: unknown;
    const res = await request(
      server(async (context) => {
        try {
          return await consume(context);
        } finally {
          aborted = context.signal.reason;
        }
      }, 100),
    )
      .post('/')
      .attach('video', Buffer.alloc(5000, 1), 'big.mp4')
      .expect(413);
    expect(res.body).toMatchObject({ code: 'V0003', metadata: { maxMb: 1 } });
    expect(aborted).toBeInstanceOf(FileTooLargeError);
  });

  it('no "video" file → 400 X0001', async () => {
    const res = await request(server(consume)).post('/').field('note', 'x').expect(400);
    expect(res.body).toMatchObject({ code: 'X0001', metadata: { fields: [{ field: 'video' }] } });
  });

  it('body that is not multipart → 400 X0001', async () => {
    const res = await request(server(consume)).post('/').send({ video: 'x' }).expect(400);
    expect(res.body.code).toBe('X0001');
  });

  it('broken multipart → 400 X0001', async () => {
    const res = await request(server(consume))
      .post('/')
      .set('content-type', 'multipart/form-data; boundary=abc')
      .send(
        '--abc\r\nContent-Disposition: form-data; name="video"; filename="a.mp4"\r\n\r\npartial',
      )
      .expect(400);
    expect(res.body.code).toBe('X0001');
  });

  it('handler rejects early → its error, the rest of the body is drained (no reset)', async () => {
    const res = await request(
      server(() => Promise.reject(VideoErrors.UNSUPPORTED_FORMAT(['.mp4'])), 1_000_000),
    )
      .post('/')
      .attach('video', Buffer.alloc(200_000, 1), 'a.txt')
      .expect(400);
    expect(res.body.code).toBe('V0002');
  });

  it('client disconnects mid-upload → the signal aborts', async () => {
    let signal: AbortSignal | undefined;
    let resolveSeen: () => void = () => undefined;
    const seen = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });
    const srv = server((context) => {
      signal = context.signal;
      resolveSeen();
      return consume(context);
    }).listen(0);
    const { port } = srv.address() as AddressInfo;

    const socket = connect(port, '127.0.0.1');
    socket.write(
      'POST / HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=b\r\n' +
        'Content-Length: 100000\r\n\r\n--b\r\nContent-Disposition: form-data; name="video"; ' +
        'filename="a.mp4"\r\n\r\npartial-bytes',
    );
    await seen;
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    srv.close();

    expect(signal?.aborted).toBe(true);
  });

  it('drainRequest reads an unread body to the end and resolves', async () => {
    const body = new PassThrough();
    const drained = drainRequest(body as unknown as IncomingMessage);
    body.end(Buffer.alloc(10));
    await expect(drained).resolves.toBeUndefined();
    await expect(drainRequest(body as unknown as IncomingMessage)).resolves.toBeUndefined();
  });
});
