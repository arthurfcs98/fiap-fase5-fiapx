import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CanActivate } from '@nestjs/common';
import {
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Registry } from '@prometheus-io/client';
import request from 'supertest';
import { HTTP_REQUEST_DURATION_SECONDS, HttpMetrics } from './http-metrics';
import type { RoutedRequest } from './http-metrics.middleware';
import {
  CLIENT_CLOSED_REQUEST_STATUS,
  createHttpMetricsMiddleware,
  normalizeHttpMethod,
  OTHER_METHOD,
  resolveHttpRoute,
  UNMATCHED_ROUTE,
} from './http-metrics.middleware';

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException();
  }
}

@Controller('videos')
class VideosController {
  @Post()
  @HttpCode(202)
  upload(): { status: string } {
    return { status: 'QUEUED' };
  }

  @Get(':id')
  findOne(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Get(':id/secret')
  @UseGuards(DenyGuard)
  secret(): never {
    throw new Error('guard deveria ter barrado');
  }

  @Get(':id/boom')
  boom(): never {
    throw new Error('falha inesperada');
  }
}

@Controller('health')
class HealthController {
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }
}

describe('createHttpMetricsMiddleware com Nest (Express 5, prefixo /api)', () => {
  let app: NestExpressApplication;
  let registry: Registry;
  let metrics: HttpMetrics;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [VideosController, HealthController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    registry = new Registry();
    metrics = new HttpMetrics(registry);
    app.use(createHttpMetricsMiddleware(registry));
    app.setGlobalPrefix('api');
    await app.init();

    const server = app.getHttpServer();
    await request(server).post('/api/videos').expect(202);
    await request(server).get('/api/videos/6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b?x=1').expect(200);
    await request(server).get('/api/videos/outro-id').expect(200);
    await request(server).get('/api/videos/abc/secret').expect(401);
    await request(server).get('/api/videos/abc/boom').expect(500);
    await request(server).get('/api/nao-existe/123').expect(404);
    await request(server).get('/api/health/live').expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('usa o padrão de rota do Nest com o prefixo global, nunca a URL com ids', async () => {
    expect(
      await metrics.requestCount({ method: 'GET', route: '/api/videos/:id', status: 200 }),
    ).toBe(2);
    expect(await metrics.requestCount({ method: 'POST', route: '/api/videos', status: 202 })).toBe(
      1,
    );

    const text = await registry.metrics();
    expect(text).not.toContain('6f1c2b3a');
    expect(text).not.toContain('outro-id');
    expect(text).not.toContain('x=1');
  });

  it('mede também o que guards e o tratamento de exceções respondem (401, 500)', async () => {
    expect(await metrics.requestCount({ route: '/api/videos/:id/secret', status: 401 })).toBe(1);
    expect(await metrics.requestCount({ route: '/api/videos/:id/boom', status: 500 })).toBe(1);
  });

  it('rota inexistente vira route="unmatched" (sem cardinalidade livre)', async () => {
    expect(await metrics.requestCount({ route: UNMATCHED_ROUTE, status: 404 })).toBe(1);
    expect(await registry.metrics()).not.toContain('nao-existe');
  });

  it('health fica fora (probes não diluem o SLI de disponibilidade)', async () => {
    expect(await metrics.requestCount({ route: '/api/health/live' })).toBe(0);
    expect(await metrics.requestCount()).toBe(6);
  });

  it('observa a duração em segundos no histograma', async () => {
    const text = await registry.metrics();
    expect(text).toMatch(
      new RegExp(
        `${HTTP_REQUEST_DURATION_SECONDS}_sum\\{method="POST",route="/api/videos",status="202"\\} [0-9.e-]+`,
      ),
    );
  });
});

describe('createHttpMetricsMiddleware (HTTP puro)', () => {
  async function withServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (port: number) => Promise<void>,
  ): Promise<void> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await run((server.address() as AddressInfo).port);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  async function waitUntil(check: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('condição não atingida');
  }

  it('cliente que desconecta antes da resposta vira status 499', async () => {
    const metrics = new HttpMetrics(new Registry());
    const middleware = createHttpMetricsMiddleware(metrics);

    await withServer(
      (req, res) => middleware(req, res, () => undefined), // nunca responde
      async (port) => {
        const client = httpRequest({ port, host: '127.0.0.1', path: '/api/videos' });
        client.on('error', () => undefined);
        client.end();
        await new Promise((resolve) => setTimeout(resolve, 50));
        client.destroy();
        await waitUntil(async () => (await metrics.requestCount()) === 1);
      },
    );

    expect(
      await metrics.requestCount({ route: UNMATCHED_ROUTE, status: CLIENT_CLOSED_REQUEST_STATUS }),
    ).toBe(1);
  });

  it('usa o relógio injetado e aceita prefixos ignorados customizados', async () => {
    const registry = new Registry();
    const metrics = new HttpMetrics(registry);
    const ticks = [1_000_000_000n, 3_500_000_000n];
    const middleware = createHttpMetricsMiddleware(metrics, {
      ignorePaths: ['/interno'],
      now: () => ticks.shift() ?? 0n,
    });

    await withServer(
      (req, res) =>
        middleware(req, res, () => {
          res.statusCode = 204;
          res.end();
        }),
      async (port) => {
        await fetch(`http://127.0.0.1:${port}/interno/x`);
        await fetch(`http://127.0.0.1:${port}/api/health/live`);
        await waitUntil(async () => (await metrics.requestCount()) === 1);
      },
    );

    const text = await registry.metrics();
    expect(text).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_sum{method="GET",route="unmatched",status="204"} 2.5`,
    );
    expect(await metrics.requestCount({ status: 204 })).toBe(1);
  });
});

describe('resolveHttpRoute', () => {
  const req = (fields: Partial<RoutedRequest>) => fields as RoutedRequest;

  it.each([
    [{ route: { path: '/api/videos/:id' } }, '/api/videos/:id'],
    [{ baseUrl: '/api', route: { path: '/videos/:id' } }, '/api/videos/:id'],
    [{ baseUrl: '', route: { path: '' } }, '/'],
    [{ route: { path: /regex/ } }, UNMATCHED_ROUTE],
    [{ route: {} }, UNMATCHED_ROUTE],
    [{}, UNMATCHED_ROUTE],
  ])('%p → %p', (fields, expected) => {
    expect(resolveHttpRoute(req(fields))).toBe(expected);
  });
});

describe('normalizeHttpMethod', () => {
  it.each([
    ['get', 'GET'],
    ['POST', 'POST'],
    ['DELETE', 'DELETE'],
    ['PROPFIND', OTHER_METHOD],
    [undefined, OTHER_METHOD],
  ])('%p → %p', (method, expected) => {
    expect(normalizeHttpMethod(method)).toBe(expected);
  });
});
