import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { createPinoHttpOptions } from './pino.config';
import {
  LOG_REDACT_CENSOR,
  PERSONAL_DATA_LOG_KEYS,
  PERSONAL_NAME_CONTAINERS,
  REDACTED_PATHS,
  SECRET_LOG_KEYS,
} from './redaction';

const R = LOG_REDACT_CENSOR;

function memoryLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  const options = createPinoHttpOptions({ serviceName: 'video-api' });
  const logger = pino({ redact: options.redact, base: undefined }, stream);
  return { logger, lines };
}

/** Todos os campos da seção 12 com valores pessoais reconhecíveis. */
function personalFields() {
  return {
    password: 'hunter2',
    authorization: 'Bearer abc',
    cookie: 'sid=1',
    email: 'ana@example.com',
    userEmail: 'ana@example.com',
    recipient: 'ana@example.com',
    name: 'Ana Souza',
    userName: 'Ana Souza',
    originalName: 'festa-da-ana.mp4',
  };
}

const CENSORED = {
  password: R,
  authorization: R,
  cookie: R,
  email: R,
  userEmail: R,
  recipient: R,
  name: R,
  userName: R,
  originalName: R,
};

describe('redação de logs (LGPD, contratos.md seção 12)', () => {
  it('declara exatamente as chaves da seção 12 (+ tokens e segredos)', () => {
    expect([...SECRET_LOG_KEYS, ...PERSONAL_DATA_LOG_KEYS, 'name'].sort()).toEqual(
      [
        'password',
        'authorization',
        'cookie',
        'email',
        'userEmail',
        'recipient',
        'name',
        'userName',
        'originalName',
        'token',
        'accessToken',
        'secret',
      ].sort(),
    );
    expect(REDACTED_PATHS).toEqual(expect.arrayContaining(['email', '*.email', '*.*.email']));
    expect(new Set(REDACTED_PATHS).size).toBe(REDACTED_PATHS.length);
  });

  it('mascara na raiz, em req.body.*, em payload.* e em event.payload.*', () => {
    const { logger, lines } = memoryLogger();

    logger.info(personalFields(), 'raiz');
    logger.info({ req: { body: personalFields() } }, 'corpo');
    logger.info({ body: personalFields() }, 'corpo sem req');
    logger.info({ payload: personalFields() }, 'payload');
    logger.info({ event: { payload: personalFields() } }, 'evento');

    expect(lines[0]).toMatchObject(CENSORED);
    expect(lines[1]).toMatchObject({ req: { body: CENSORED } });
    expect(lines[2]).toMatchObject({ body: CENSORED });
    expect(lines[3]).toMatchObject({ payload: CENSORED });
    expect(lines[4]).toMatchObject({ event: { payload: CENSORED } });
    const raw = JSON.stringify(lines);
    for (const value of ['hunter2', 'ana@example.com', 'Ana Souza', 'festa-da-ana', 'sid=1']) {
      expect(raw).not.toContain(value);
    }
  });

  it('mascara e-mail em qualquer objeto até dois níveis (*.email, *.*.email)', () => {
    const { logger, lines } = memoryLogger();

    logger.info({ notification: { recipient: 'a@x.com', email: 'a@x.com' } });
    logger.info({ job: { data: { email: 'a@x.com', userEmail: 'a@x.com' } } });
    logger.info({ req: { user: { name: 'Ana', email: 'a@x.com' } } });

    expect(lines[0]).toMatchObject({ notification: { recipient: R, email: R } });
    expect(lines[1]).toMatchObject({ job: { data: { email: R, userEmail: R } } });
    expect(lines[2]).toMatchObject({ req: { user: { name: R, email: R } } });
  });

  it('preserva ids, nomes técnicos e o erro serializado (name só é mascarado onde é pessoa)', () => {
    const { logger, lines } = memoryLogger();
    class RetryableError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'RetryableError';
      }
    }

    logger.error(
      {
        userId: 'u-1',
        videoId: 'v-1',
        queue: { name: 'notification.events' },
        bucket: { name: 'fiapx-raw' },
        err: new RetryableError('broker fora'),
      },
      'falha',
    );

    expect(lines[0]).toMatchObject({
      userId: 'u-1',
      videoId: 'v-1',
      queue: { name: 'notification.events' },
      bucket: { name: 'fiapx-raw' },
      err: { type: 'RetryableError', name: 'RetryableError', message: 'broker fora' },
    });
  });

  it('não altera o objeto original (a requisição continua com o header de auth)', () => {
    const { logger } = memoryLogger();
    const req = { headers: { authorization: 'Bearer abc' }, body: personalFields() };

    logger.info({ req }, 'x');

    expect(req.headers.authorization).toBe('Bearer abc');
    expect(req.body).toEqual(personalFields());
  });

  it('cobre os contêineres de name declarados', () => {
    expect(PERSONAL_NAME_CONTAINERS).toEqual([
      'req.body',
      'body',
      'payload',
      '*.payload',
      'user',
      '*.user',
    ]);
  });

  it('no log de acesso do pino-http, Authorization e Cookie não aparecem (nem os headers)', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        callback();
      },
    });
    const middleware = pinoHttp(createPinoHttpOptions({ serviceName: 'video-api' }), stream);
    const server = createServer((req, res) => {
      middleware(req, res);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
        headers: { authorization: 'Bearer segredo', cookie: 'sid=abc' },
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const access = lines.find((line) => line['msg'] === 'request completed');
    expect(access?.['req']).toMatchObject({ method: 'GET', url: '/api/auth/me' });
    expect(access?.['req']).not.toHaveProperty('headers');
    expect(JSON.stringify(lines)).not.toContain('segredo');
    expect(JSON.stringify(lines)).not.toContain('sid=abc');
  });
});
