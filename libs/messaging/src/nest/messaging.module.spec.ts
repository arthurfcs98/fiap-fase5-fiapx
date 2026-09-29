import { MetricsServerModule, METRICS_REGISTRY } from '@fiapx/observability';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Registry } from '@prometheus-io/client';
import { AmqpConnection } from '../connection/amqp-connection';
import { MessagingMetrics } from '../messaging.metrics';
import type { EventPublisher } from '../publisher/event-publisher.port';
import { EVENT_PUBLISHER } from '../publisher/event-publisher.port';
import { MessagePublisher } from '../publisher/message-publisher';
import { TopologyInitializer } from '../topology-setup';
import { MessageConsumers } from './message-consumers.service';
import { MessagingModule } from './messaging.module';

/** Provider de outro módulo (como um caso de uso do app) injetando os exports globais. */
@Injectable()
class NeedsMessaging {
  constructor(
    readonly consumers: MessageConsumers,
    @Inject(EVENT_PUBLISHER) readonly publisher: EventPublisher,
  ) {}
}

/**
 * Wiring do módulo (sem broker: a URL aponta para uma porta fechada e a conexão fica tentando
 * em segundo plano, como no boot real com o RabbitMQ fora).
 */
describe('MessagingModule', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterAll(() => {
    Logger.overrideLogger(new Logger());
  });

  it('forRoot expõe conexão, publicador (também como EVENT_PUBLISHER), consumidores e métricas', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MessagingModule.forRoot({
          url: 'amqp://127.0.0.1:1',
          connectionName: 'modulo-teste',
          reconnectTimeInSeconds: 1,
        }),
      ],
      providers: [NeedsMessaging],
    }).compile();
    const app = await moduleRef.init();

    expect(app.get(NeedsMessaging).publisher).toBe(app.get(MessagePublisher));
    expect(app.get(AmqpConnection).connectionName).toBe('modulo-teste');
    expect(app.get(EVENT_PUBLISHER)).toBe(app.get(MessagePublisher));
    expect(app.get(MessageConsumers).all).toEqual([]);
    expect(app.get(TopologyInitializer).isReady).toBe(false);
    expect(app.get(MessagingMetrics)).toBeInstanceOf(MessagingMetrics);

    await app.close();
  });

  it('forRootAsync usa o METRICS_REGISTRY do serviço e pode dispensar a topologia', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MetricsServerModule.forRoot({
          serviceName: 'svc',
          version: 't',
          port: 0,
          host: '127.0.0.1',
        }),
        MessagingModule.forRootAsync({
          useFactory: () => ({
            url: 'amqp://127.0.0.1:1',
            connectionName: 'svc',
            assertTopology: false,
            reconnectTimeInSeconds: 1,
          }),
        }),
      ],
    }).compile();
    const app = await moduleRef.init();

    app.get(MessagingMetrics).consumed('q', 'success');
    const registry = app.get<Registry>(METRICS_REGISTRY);
    expect(await registry.metrics()).toContain('fiapx_messages_consumed_total');
    expect(app.get(TopologyInitializer).isReady).toBe(true);

    await app.close();
  });
});
