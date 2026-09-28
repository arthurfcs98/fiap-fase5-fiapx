import { MetricsServerService } from '@fiapx/observability';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { ApiConfig } from '../src/config/api.config';
import { API_CONFIG } from '../src/config/api.config';

/**
 * E2E do video-api: sobe o AppModule real (config zod, pino, filtro global, interceptor de
 * correlação, Terminus, Swagger) com a mesma configuração HTTP do main.ts.
 */
describe('video-api health (e2e)', () => {
  let app: NestExpressApplication;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    process.env['LOG_LEVEL'] = 'silent';
    process.env['APP_VERSION'] = 'e2e-sha1234';
    process.env['METRICS_PORT'] = '0';
    process.env['METRICS_HOST'] = '127.0.0.1';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app, app.get<ApiConfig>(API_CONFIG));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = previousEnv;
  });

  it('GET /api/health/live → 200 com serviço e versão de build', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/live').expect(200);

    expect(res.body).toEqual({ status: 'ok', service: 'video-api', version: 'e2e-sha1234' });
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propaga o x-correlation-id recebido', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health/live')
      .set('x-correlation-id', 'teste-e2e-001')
      .expect(200);

    expect(res.headers['x-correlation-id']).toBe('teste-e2e-001');
  });

  it('GET /api/health/ready → 200 via Terminus (sem dependências na E0)', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);

    expect(res.body).toEqual({ status: 'ok', info: {}, error: {}, details: {} });
  });

  it('rota inexistente → 404 no envelope de erro padrão', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/nao-existe')
      .set('x-correlation-id', 'cid-404')
      .expect(404);

    expect(res.body).toMatchObject({
      statusCode: 404,
      error: { message: 'NOT_FOUND', code: 'X0404', metadata: {} },
      path: '/api/nao-existe',
      correlationId: 'cid-404',
    });
  });

  it('GET /api/docs-json → OpenAPI com esquema Bearer e rotas de health', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);

    expect(res.body.components.securitySchemes.bearer).toMatchObject({ scheme: 'bearer' });
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/api/health/live', '/api/health/ready']),
    );
  });

  it('servidor interno de métricas (fora do /api) expõe /health e /metrics do video-api', async () => {
    const port = app.get(MetricsServerService).server.port;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await health.json()).toEqual({
      status: 'ok',
      service: 'video-api',
      version: 'e2e-sha1234',
    });
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(metrics).toContain('service="video-api"');
  });
});
