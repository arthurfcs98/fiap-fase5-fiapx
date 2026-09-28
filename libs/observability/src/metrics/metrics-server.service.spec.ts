import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Registry } from '@prometheus-io/client';
import { MetricsServerModule } from './metrics-server.module';
import { METRICS_REGISTRY } from './metrics-server.options';
import { MetricsServerService } from './metrics-server.service';

describe('MetricsServerService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  it('sobe no bootstrap, fica 503 no início do shutdown e fecha no fim', async () => {
    const app = await Test.createTestingModule({
      imports: [
        MetricsServerModule.forRoot({
          serviceName: 'notification-service',
          version: 'v1',
          port: 0,
          host: '127.0.0.1',
        }),
      ],
    }).compile();
    await app.init();

    const service = app.get(MetricsServerService);
    const base = `http://127.0.0.1:${service.server.port}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(await (await fetch(`${base}/metrics`)).text()).toContain(
      'service="notification-service"',
    );

    service.onModuleDestroy();
    expect(service.isShuttingDown).toBe(true);
    expect((await fetch(`${base}/health`)).status).toBe(503);

    await app.close();
    expect(service.server.port).toBeUndefined();
    app.get<Registry>(METRICS_REGISTRY).clear();
  });

  it('forRootAsync: resolve opções por factory e pode desligar métricas padrão', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MetricsServerModule.forRootAsync({
          useFactory: () => ({
            serviceName: 'video-worker',
            version: 'v2',
            port: 0,
            defaultMetrics: false,
          }),
        }),
      ],
    }).compile();

    const registry = moduleRef.get<Registry>(METRICS_REGISTRY);
    expect(await registry.metrics()).not.toContain('process_cpu_user_seconds_total');

    const service = moduleRef.get(MetricsServerService);
    await service.onApplicationBootstrap();
    expect(service.server.port).toEqual(expect.any(Number));
    await service.onApplicationShutdown('SIGTERM');
    expect(Logger.prototype.log).toHaveBeenCalledWith('Servidor de métricas encerrado (SIGTERM)');
  });

  it('é global: módulos de feature injetam o registry sem importar o forRoot de novo', async () => {
    @Injectable()
    class FeatureMetrics {
      constructor(@Inject(METRICS_REGISTRY) readonly registry: Registry) {}
    }
    @Module({ providers: [FeatureMetrics], exports: [FeatureMetrics] })
    class FeatureModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        MetricsServerModule.forRoot({ serviceName: 'video-api', version: 'v', port: 0 }),
        FeatureModule,
      ],
    }).compile();

    const registry = moduleRef.get<Registry>(METRICS_REGISTRY);
    expect(moduleRef.get(FeatureMetrics).registry).toBe(registry);
    registry.clear();
  });

  it('isGlobal: false restringe o registry ao módulo que importou o forRoot', async () => {
    @Injectable()
    class FeatureMetrics {
      constructor(@Inject(METRICS_REGISTRY) readonly registry: Registry) {}
    }
    @Module({ providers: [FeatureMetrics] })
    class FeatureModule {}

    await expect(
      Test.createTestingModule({
        imports: [
          MetricsServerModule.forRoot({
            serviceName: 'video-api',
            version: 'v',
            port: 0,
            isGlobal: false,
          }),
          FeatureModule,
        ],
      }).compile(),
    ).rejects.toThrow(/METRICS_REGISTRY/);
  });
});
