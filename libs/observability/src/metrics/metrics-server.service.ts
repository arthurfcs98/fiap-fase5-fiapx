import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
} from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';
import type { HealthRegistry } from '../health/health-registry';
import { HEALTH_REGISTRY } from '../health/health-registry';
import { MetricsServer } from './metrics-server';
import type { MetricsServerModuleOptions } from './metrics-server.options';
import { METRICS_REGISTRY, METRICS_SERVER_OPTIONS } from './metrics-server.options';

/**
 * Liga o {@link MetricsServer} ao ciclo de vida do Nest:
 * - sobe no bootstrap;
 * - no SIGTERM (`enableShutdownHooks`), `/health` passa a 503 assim que o shutdown começa
 *   (onModuleDestroy) e o servidor fecha por último (onApplicationShutdown);
 * - `/health` também falha enquanto uma verificação do {@link HealthRegistry} falhar (ex.:
 *   consumidor de fila que o broker cancelou e não voltou).
 */
@Injectable()
export class MetricsServerService
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger('MetricsServer');
  private shuttingDown = false;
  readonly server: MetricsServer;

  constructor(
    @Inject(METRICS_SERVER_OPTIONS) private readonly options: MetricsServerModuleOptions,
    @Inject(METRICS_REGISTRY) registry: Registry,
    @Inject(HEALTH_REGISTRY) health: HealthRegistry,
  ) {
    this.server = new MetricsServer({
      serviceName: options.serviceName,
      version: options.version,
      port: options.port,
      host: options.host,
      token: options.token,
      registry,
      isReady: () => !this.shuttingDown,
      failingChecks: () => health.failing(),
    });
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async onApplicationBootstrap(): Promise<void> {
    const port = await this.server.start();
    this.logger.log(`/health e /metrics em ${this.options.host ?? '0.0.0.0'}:${port}`);
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.server.stop();
    this.logger.log(`Servidor de métricas encerrado${signal ? ` (${signal})` : ''}`);
  }
}
