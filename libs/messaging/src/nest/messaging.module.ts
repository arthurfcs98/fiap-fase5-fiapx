import { METRICS_REGISTRY } from '@fiapx/observability';
import { Module } from '@nestjs/common';
import { Registry } from '@prometheus-io/client';
import { AmqpConnection } from '../connection/amqp-connection';
import { MessagingMetrics } from '../messaging.metrics';
import { EVENT_PUBLISHER } from '../publisher/event-publisher.port';
import { MessagePublisher } from '../publisher/message-publisher';
import { buildTopology } from '../topology';
import { TopologyInitializer } from '../topology-setup';
import { MessageConsumers } from './message-consumers.service';
import { MessagingLifecycle } from './messaging-lifecycle.service';
import type { MessagingModuleOptions } from './messaging.options';
import { MESSAGING_OPTIONS, MessagingConfigurableModule } from './messaging.options';

/**
 * `MessagingModule.forRootAsync({ inject: [CONFIG], useFactory: (c) => ({ url: c.RABBITMQ_URL,
 * connectionName: SERVICE_NAME }) })`, UMA vez no módulo raiz (global). Exporta
 * {@link AmqpConnection}, {@link MessagePublisher} (também como `EVENT_PUBLISHER`), {@link MessageConsumers},
 * {@link TopologyInitializer} e {@link MessagingMetrics}.
 *
 * As métricas usam o `METRICS_REGISTRY` do `MetricsServerModule` quando ele existe.
 */
@Module({
  providers: [
    {
      provide: AmqpConnection,
      inject: [MESSAGING_OPTIONS],
      useFactory: (options: MessagingModuleOptions) =>
        new AmqpConnection({
          url: options.url,
          connectionName: options.connectionName,
          heartbeatIntervalInSeconds: options.heartbeatIntervalInSeconds,
          reconnectTimeInSeconds: options.reconnectTimeInSeconds,
        }),
    },
    {
      provide: TopologyInitializer,
      inject: [AmqpConnection, MESSAGING_OPTIONS],
      useFactory: (connection: AmqpConnection, options: MessagingModuleOptions) =>
        new TopologyInitializer(
          connection,
          options.assertTopology === false ? undefined : buildTopology(options.topology),
        ),
    },
    {
      provide: MessagingMetrics,
      inject: [{ token: METRICS_REGISTRY, optional: true }],
      useFactory: (registry?: Registry) => new MessagingMetrics(registry ?? new Registry()),
    },
    {
      provide: MessagePublisher,
      inject: [AmqpConnection, TopologyInitializer, MESSAGING_OPTIONS],
      useFactory: (
        connection: AmqpConnection,
        topology: TopologyInitializer,
        options: MessagingModuleOptions,
      ) =>
        new MessagePublisher(connection, {
          confirmTimeoutMs: options.confirmTimeoutMs,
          appId: options.connectionName,
          beforePublish: () => topology.whenReady(),
        }),
    },
    { provide: EVENT_PUBLISHER, useExisting: MessagePublisher },
    MessageConsumers,
    MessagingLifecycle,
  ],
  exports: [
    AmqpConnection,
    EVENT_PUBLISHER,
    MessagePublisher,
    MessageConsumers,
    TopologyInitializer,
    MessagingMetrics,
  ],
})
export class MessagingModule extends MessagingConfigurableModule {}
