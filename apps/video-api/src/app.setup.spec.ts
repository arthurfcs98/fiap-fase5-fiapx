import { Controller, Get, Logger } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { GlobalExceptionFilter, loadConfig } from '@fiapx/common';
import { getCorrelationId } from '@fiapx/observability';
import request from 'supertest';
import { configureApp, setupSwagger } from './app.setup';
import { apiConfigSchema } from './config/api.config';

@Controller('ping')
class PingController {
  @Get()
  ping(): { pong: true } {
    return { pong: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('falha inesperada');
  }
}

async function createApp(env: Record<string, string>): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [PingController],
    providers: [{ provide: APP_FILTER, useClass: GlobalExceptionFilter }],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, loadConfig(apiConfigSchema, env));
  await app.init();
  return app;
}

describe('configureApp', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('aplica o prefixo /api e remove o header x-powered-by', async () => {
    app = await createApp({});
    const res = await request(app.getHttpServer()).get('/api/ping').expect(200);
    expect(res.body).toEqual({ pong: true });
    expect(res.headers['x-powered-by']).toBeUndefined();
    await request(app.getHttpServer()).get('/ping').expect(404);
  });

  it('abre o contexto de correlação antes de tudo: o log do 5xx no filtro global tem o id', async () => {
    const seen: Array<string | undefined> = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      seen.push(getCorrelationId());
    });
    app = await createApp({});

    const res = await request(app.getHttpServer())
      .get('/api/ping/boom')
      .set('x-correlation-id', 'cid-filtro-500')
      .expect(500);

    expect(res.headers['x-correlation-id']).toBe('cid-filtro-500');
    expect(res.body).toMatchObject({ error: { code: 'X0002' }, correlationId: 'cid-filtro-500' });
    expect(seen).toEqual(['cid-filtro-500']);
  });

  it('gera o correlation id quando o cliente não envia', async () => {
    app = await createApp({});
    const res = await request(app.getHttpServer()).get('/api/ping').expect(200);
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('publica o Swagger em /api/docs com esquema Bearer e a versão de build', async () => {
    app = await createApp({ APP_VERSION: 'abc1234' });
    const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(res.body.info).toMatchObject({ title: 'FIAP X: video-api', version: 'abc1234' });
    expect(res.body.components.securitySchemes.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    expect(Object.keys(res.body.paths)).toContain('/api/ping');
    await request(app.getHttpServer()).get('/api/docs').expect(200);
  });

  it('não publica o Swagger quando SWAGGER_ENABLED=false', async () => {
    app = await createApp({ SWAGGER_ENABLED: 'false' });
    await request(app.getHttpServer()).get('/api/docs-json').expect(404);
  });

  it('setupSwagger retorna o documento gerado', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [PingController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.setGlobalPrefix('api');
    const document = setupSwagger(app, loadConfig(apiConfigSchema, {}));
    expect(document.openapi).toMatch(/^3\./);
  });
});
