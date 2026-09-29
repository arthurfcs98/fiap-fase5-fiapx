import { GlobalExceptionFilter } from '@fiapx/common';
import { getCorrelationId, HttpMetrics, METRICS_REGISTRY } from '@fiapx/observability';
import { Controller, Get, Logger, Module, Req } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Registry } from '@prometheus-io/client';
import request from 'supertest';
import { testConfig } from '../test/support/config';
import { configureApp, helmetOptions, setupSwagger, TRUSTED_PROXIES } from './app.setup';

@Controller('ping')
class PingController {
  @Get()
  ping(): { pong: true } {
    return { pong: true };
  }

  @Get('ip')
  ip(@Req() req: { ip?: string }): { ip?: string } {
    return { ip: req.ip };
  }

  @Get('boom')
  boom(): never {
    throw new Error('falha inesperada');
  }
}

async function createApp(
  env: Record<string, string> = {},
  registry?: Registry,
): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [PingController],
    providers: [
      { provide: APP_FILTER, useClass: GlobalExceptionFilter },
      ...(registry ? [{ provide: METRICS_REGISTRY, useValue: registry }] : []),
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, testConfig(env));
  await app.init();
  return app;
}

describe('configureApp', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('applies the /api prefix and removes x-powered-by', async () => {
    app = await createApp();
    const res = await request(app.getHttpServer()).get('/api/ping').expect(200);
    expect(res.body).toEqual({ pong: true });
    expect(res.headers['x-powered-by']).toBeUndefined();
    await request(app.getHttpServer()).get('/ping').expect(404);
  });

  it('opens the correlation context first: the 5xx log in the global filter has the id', async () => {
    const seen: Array<string | undefined> = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      seen.push(getCorrelationId());
    });
    app = await createApp();

    const res = await request(app.getHttpServer())
      .get('/api/ping/boom')
      .set('x-correlation-id', 'cid-filtro-500')
      .expect(500);

    expect(res.headers['x-correlation-id']).toBe('cid-filtro-500');
    expect(res.body).toMatchObject({ error: { code: 'X0002' }, correlationId: 'cid-filtro-500' });
    expect(seen).toEqual(['cid-filtro-500']);
  });

  it('generates the correlation id when the client sends none', async () => {
    app = await createApp();
    const res = await request(app.getHttpServer()).get('/api/ping').expect(200);
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends the security headers (strict CSP without inline scripts, no framing)', async () => {
    app = await createApp();
    const res = await request(app.getHttpServer()).get('/api/ping').expect(200);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(helmetOptions().crossOriginEmbedderPolicy).toBe(false);
  });

  it('trusts X-Forwarded-For only from private proxies', async () => {
    app = await createApp();
    expect(TRUSTED_PROXIES).toBe('loopback, linklocal, uniquelocal');
    // supertest connects from loopback (a trusted proxy), so the forwarded client IP is used.
    const res = await request(app.getHttpServer())
      .get('/api/ping/ip')
      .set('x-forwarded-for', '203.0.113.7')
      .expect(200);
    expect(res.body).toEqual({ ip: '203.0.113.7' });
  });

  it('enables CORS only for CORS_ORIGIN', async () => {
    app = await createApp({ CORS_ORIGIN: 'https://fiapx.asdevit.com' });
    const allowed = await request(app.getHttpServer())
      .options('/api/ping')
      .set('origin', 'https://fiapx.asdevit.com')
      .set('access-control-request-method', 'POST')
      .set('access-control-request-headers', 'authorization,idempotency-key');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://fiapx.asdevit.com');
    expect(String(allowed.headers['access-control-allow-headers'])).toContain('Idempotency-Key');

    const other = await request(app.getHttpServer())
      .get('/api/ping')
      .set('origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends no CORS headers without CORS_ORIGIN (same origin only)', async () => {
    app = await createApp();
    const res = await request(app.getHttpServer())
      .get('/api/ping')
      .set('origin', 'https://fiapx.asdevit.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('measures fiapx_http_request_duration_seconds with the route pattern', async () => {
    const registry = new Registry();
    app = await createApp({}, registry);
    await request(app.getHttpServer()).get('/api/ping').expect(200);
    await request(app.getHttpServer()).get('/api/ping/boom').expect(500);

    const metrics = new HttpMetrics(registry);
    await expect(
      metrics.requestCount({ method: 'GET', route: '/api/ping', status: 200 }),
    ).resolves.toBe(1);
    await expect(metrics.requestCount({ route: '/api/ping/boom', status: 500 })).resolves.toBe(1);
  });

  it('publishes Swagger at /api/docs with the Bearer scheme and the build version', async () => {
    app = await createApp({ APP_VERSION: 'abc1234' });
    const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(res.body.info).toMatchObject({ title: 'FIAP Frames: video-api', version: 'abc1234' });
    expect(res.body.components.securitySchemes.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    expect(Object.keys(res.body.paths)).toContain('/api/ping');
    await request(app.getHttpServer()).get('/api/docs').expect(200);
  });

  it('does not publish Swagger when SWAGGER_ENABLED=false', async () => {
    app = await createApp({ SWAGGER_ENABLED: 'false' });
    await request(app.getHttpServer()).get('/api/docs-json').expect(404);
  });

  it('setupSwagger returns the generated document', async () => {
    @Module({ controllers: [PingController] })
    class PingModule {}
    const moduleRef = await Test.createTestingModule({ imports: [PingModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.setGlobalPrefix('api');
    const document = setupSwagger(app, testConfig());
    expect(document.openapi).toMatch(/^3\./);
  });
});
