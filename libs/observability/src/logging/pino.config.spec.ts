import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoHttp from 'pino-http';
import type { Options } from 'pino-http';
import { runWithCorrelation } from '../correlation';
import {
  accessLogLevel,
  correlationMixin,
  createPinoConfig,
  createPinoHttpOptions,
  DEFAULT_IGNORED_PATHS,
  shouldSkipAccessLog,
} from './pino.config';

function memoryStream() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { stream, lines };
}

describe('createPinoConfig', () => {
  it('usa stdout síncrono por padrão (logs do shutdown não se perdem)', () => {
    const { pinoHttp } = createPinoConfig({ serviceName: 'x' });
    expect(Array.isArray(pinoHttp)).toBe(true);
    const [options, stream] = pinoHttp as [Options, { sync?: boolean; fd?: number }];
    expect(options.base).toMatchObject({ service: 'x' });
    expect(stream.sync).toBe(true);
    expect(stream.fd).toBe(1);
  });

  it('aceita destino customizado', () => {
    const { stream } = memoryStream();
    const { pinoHttp } = createPinoConfig({ serviceName: 'x', destination: stream });
    expect((pinoHttp as [Options, unknown])[1]).toBe(stream);
  });
});

describe('createPinoHttpOptions', () => {
  const options = createPinoHttpOptions({
    serviceName: 'video-api',
    version: 'abc1234',
    level: 'debug',
  });

  it('parametriza serviço, versão e nível', () => {
    expect(options.level).toBe('debug');
    expect(options.base).toMatchObject({ service: 'video-api', version: 'abc1234' });
  });

  it('usa defaults seguros', () => {
    const defaults = createPinoHttpOptions({ serviceName: 'x' });
    expect(defaults.level).toBe('info');
    expect(defaults.base).toMatchObject({ version: 'dev' });
  });

  it('gera logs JSON com service, level textual, time ISO, correlationId e segredos mascarados', () => {
    const { stream, lines } = memoryStream();
    const logger = pino(
      {
        level: options.level,
        base: options.base,
        timestamp: options.timestamp,
        formatters: options.formatters,
        mixin: options.mixin,
        redact: options.redact,
      },
      stream,
    );

    runWithCorrelation('cid-42', () =>
      logger.info(
        {
          password: 'hunter2',
          user: { password: 'x', token: 't' },
          req: { headers: { authorization: 'Bearer abc' }, body: { password: 'p', name: 'Ana' } },
          account: { credentials: { secret: 's', accessToken: 'a' } },
        },
        'login',
      ),
    );
    logger.info('fora de contexto');

    const [inside, outside] = lines;
    expect(inside).toMatchObject({
      level: 'info',
      service: 'video-api',
      version: 'abc1234',
      correlationId: 'cid-42',
      password: '[REDACTED]',
      user: { password: '[REDACTED]', token: '[REDACTED]' },
      req: {
        headers: { authorization: '[REDACTED]' },
        body: { password: '[REDACTED]', name: 'Ana' },
      },
      account: { credentials: { secret: '[REDACTED]', accessToken: '[REDACTED]' } },
      msg: 'login',
    });
    expect(typeof inside?.['time']).toBe('string');
    expect(new Date(inside?.['time'] as string).toISOString()).toBe(inside?.['time']);
    expect(outside).not.toHaveProperty('correlationId');
  });

  it('no acesso HTTP: reaproveita/gera o id, devolve no header e ignora health', async () => {
    const { stream, lines } = memoryStream();
    const middleware = pinoHttp(options, stream);
    const server = createServer((req, res) => {
      middleware(req, res);
      res.statusCode = req.url === '/boom' ? 500 : req.url === '/nada' ? 404 : 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      const withHeader = await fetch(`${base}/api/videos`, {
        headers: { 'x-correlation-id': 'cliente-1' },
      });
      const withoutHeader = await fetch(`${base}/api/videos`);
      await fetch(`${base}/api/health/live`);
      await fetch(`${base}/nada`);
      await fetch(`${base}/boom`);

      expect(withHeader.headers.get('x-correlation-id')).toBe('cliente-1');
      expect(withoutHeader.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const access = lines.filter((line) => line['msg'] === 'request completed' || line['err']);
    expect(access).toHaveLength(4); // health não gera log de acesso
    expect(access[0]).toMatchObject({
      level: 'info',
      correlationId: 'cliente-1',
      service: 'video-api',
    });
    expect(access[2]).toMatchObject({ level: 'warn' });
    expect(access[3]).toMatchObject({ level: 'error' });
    expect(access[3]?.['correlationId']).toEqual(expect.any(String));
  });
});

describe('correlationMixin', () => {
  it('só adiciona correlationId dentro de um contexto', () => {
    expect(correlationMixin()).toEqual({});
    expect(runWithCorrelation('x', correlationMixin)).toEqual({ correlationId: 'x' });
  });
});

describe('shouldSkipAccessLog', () => {
  it.each([
    ['/api/health/live', true],
    ['/api/health', true],
    ['/health?probe=1', true],
    ['/metrics', true],
    ['/api/docs/swagger-ui.css', true],
    ['/api/healthcheck', false],
    ['/api/videos', false],
    [undefined, false],
  ])('%p → %p', (url, expected) => {
    expect(shouldSkipAccessLog(url, DEFAULT_IGNORED_PATHS)).toBe(expected);
  });
});

describe('accessLogLevel', () => {
  const res = (statusCode: number) => ({ statusCode }) as never;
  it('classifica pelo status e pelo erro', () => {
    expect(accessLogLevel({} as never, res(200))).toBe('info');
    expect(accessLogLevel({} as never, res(404))).toBe('warn');
    expect(accessLogLevel({} as never, res(503))).toBe('error');
    expect(accessLogLevel({} as never, res(200), new Error('x'))).toBe('error');
  });
});
