import type { HealthRegistry } from '@fiapx/observability';
import { HEALTH_REGISTRY } from '@fiapx/observability';
import type { OnModuleDestroy } from '@nestjs/common';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { z } from 'zod';
import { AmqpConnection } from '../connection/amqp-connection';
import { ConsumerRunner } from '../consumer/consumer-runner';
import type { ConsumableEvent, ConsumerDefinition } from '../consumer/consumer.types';
import { MessagingMetrics } from '../messaging.metrics';
import { MessagePublisher } from '../publisher/message-publisher';
import { TopologyInitializer } from '../topology-setup';
import type { MessagingModuleOptions } from './messaging.options';
import { MESSAGING_OPTIONS } from './messaging.options';

/** Nome da verificação dos consumidores no `HEALTH_REGISTRY` (`/health` da porta 9464). */
export const CONSUMERS_HEALTH_CHECK = 'messaging-consumers';

/**
 * Registro dos consumidores do serviço. Cada app chama {@link start} no
 * `onApplicationBootstrap` do seu consumer (camada `interfaces`); no shutdown (SIGTERM) todos
 * param de consumir e esperam as mensagens em processamento (`onModuleDestroy`, antes de o
 * banco e a conexão AMQP fecharem).
 *
 * Com o `MetricsServerModule` no app, registra no `HEALTH_REGISTRY` a verificação
 * {@link CONSUMERS_HEALTH_CHECK}: o `/health` falha se um consumidor ficar sem consumer ativo
 * com o broker conectado (ex.: cancelado pelo broker e sem conseguir re-assinar).
 */
@Injectable()
export class MessageConsumers implements OnModuleDestroy {
  private readonly runners: ConsumerRunner<z.ZodType<ConsumableEvent>>[] = [];

  constructor(
    private readonly connection: AmqpConnection,
    private readonly publisher: MessagePublisher,
    private readonly metrics: MessagingMetrics,
    private readonly topology: TopologyInitializer,
    @Inject(MESSAGING_OPTIONS) private readonly options: MessagingModuleOptions,
    @Optional() @Inject(HEALTH_REGISTRY) health?: HealthRegistry,
  ) {
    health?.register(CONSUMERS_HEALTH_CHECK, () =>
      this.runners.every((runner) => runner.isHealthy),
    );
  }

  /** Cria e inicia o consumidor (não bloqueia se o broker estiver fora). */
  start<TSchema extends z.ZodType<ConsumableEvent>>(
    definition: ConsumerDefinition<TSchema>,
  ): ConsumerRunner<TSchema> {
    if (this.runners.some((runner) => runner.queue === definition.queue)) {
      throw new Error(`Já existe um consumidor registrado para ${definition.queue}`);
    }
    const runner = new ConsumerRunner(definition, {
      connection: this.connection,
      publisher: this.publisher,
      metrics: this.metrics,
      beforeConsume: () => this.topology.whenReady(),
      ensureTopology: () => this.topology.redeclare(),
      shutdownTimeoutMs: this.options.shutdownTimeoutMs,
    });
    runner.start();
    this.runners.push(runner);
    return runner;
  }

  /** Consumidores registrados (readiness, testes). */
  get all(): readonly ConsumerRunner<z.ZodType<ConsumableEvent>>[] {
    return this.runners;
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.runners.map((runner) => runner.stop()));
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopAll();
  }
}
