import { createStandaloneApp } from '@fiapx/observability';
import type { INestApplicationContext } from '@nestjs/common';
import { MetricsServerService } from '@fiapx/observability';
import { NotificationModule } from './notification.module';

/** Sobe o módulo real (config + pino + servidor de métricas) numa porta efêmera. */
describe('NotificationModule (wiring)', () => {
  const previousEnv = { ...process.env };
  let app: INestApplicationContext | undefined;

  beforeEach(() => {
    process.env['LOG_LEVEL'] = 'silent';
    process.env['APP_VERSION'] = 'test-sha';
    process.env['METRICS_PORT'] = '0';
    process.env['METRICS_HOST'] = '127.0.0.1';
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    process.env = { ...previousEnv };
  });

  it('expõe /health e /metrics e encerra o servidor no shutdown', async () => {
    app = await createStandaloneApp(NotificationModule);
    const service = app.get(MetricsServerService);
    const base = `http://127.0.0.1:${service.server.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: 'ok',
      service: 'notification-service',
      version: 'test-sha',
    });
    expect(await (await fetch(`${base}/metrics`)).text()).toContain(
      'service="notification-service"',
    );

    await app.close();
    app = undefined;
    expect(service.server.port).toBeUndefined();
  });

  it('protege /metrics quando METRICS_TOKEN é definido', async () => {
    process.env['METRICS_TOKEN'] = 'token-de-teste-1234';
    app = await createStandaloneApp(NotificationModule);
    const base = `http://127.0.0.1:${app.get(MetricsServerService).server.port}`;

    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const authorized = await fetch(`${base}/metrics`, {
      headers: { authorization: 'Bearer token-de-teste-1234' },
    });
    expect(authorized.status).toBe(200);
  });

  it('não sobe com configuração inválida', async () => {
    process.env['METRICS_PORT'] = 'porta';
    await expect(createStandaloneApp(NotificationModule)).rejects.toThrow(/METRICS_PORT/);
  });
});
