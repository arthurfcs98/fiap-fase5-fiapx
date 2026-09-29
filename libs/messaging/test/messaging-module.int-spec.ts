import type { VideoUploadedEvent } from '@fiapx/contracts';
import { createEvent, processingStartedEvent, videoUploadedEvent } from '@fiapx/contracts';
import { videoUploadedFixture } from '@fiapx/contracts/fixtures';
import { getCorrelationId, MetricsServerModule, MetricsServerService } from '@fiapx/observability';
import type { StartedRabbitMq } from '@fiapx/testing';
import { delay, quietNestLogs, startRabbitMq, waitFor } from '@fiapx/testing';
import type { INestApplicationContext, OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ChannelModel, GetMessage } from 'amqplib';
import { connect } from 'amqplib';
import type { EventPublisher } from '../src';
import {
  EVENT_PUBLISHER,
  MessageConsumers,
  MessagingModule,
  QUEUES,
  TopologyInitializer,
} from '../src';

/**
 * EXEMPLO de uso no app (camada `interfaces`): o consumer é um provider que registra a
 * definição no `onApplicationBootstrap`; o handler chama o caso de uso e publica pela porta
 * `EVENT_PUBLISHER`. Aqui o "caso de uso" só publica `video.processing.started`.
 */
@Injectable()
class VideoUploadedConsumer implements OnApplicationBootstrap {
  readonly handled: { id: string; correlationId?: string }[] = [];
  processingDelayMs = 0;

  constructor(
    private readonly consumers: MessageConsumers,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.start({
      queue: QUEUES.workerVideoUploaded,
      schema: videoUploadedEvent,
      prefetch: 1,
      handle: (event) => this.process(event),
    });
  }

  private async process(event: VideoUploadedEvent): Promise<void> {
    await delay(this.processingDelayMs);
    await this.publisher.publishEvent(
      createEvent(
        'video.processing.started',
        { videoId: event.payload.videoId, attempt: 1, workerId: 'worker-int' },
        // Dentro do handler, o correlation id do contexto é o do envelope recebido.
        getCorrelationId() ?? event.correlationId,
      ),
    );
    this.handled.push({ id: event.id, correlationId: getCorrelationId() });
  }
}

describe('MessagingModule no ciclo de vida do Nest (RabbitMQ real)', () => {
  let rabbit: StartedRabbitMq;
  let admin: ChannelModel;

  beforeAll(async () => {
    quietNestLogs();
    rabbit = await startRabbitMq();
    admin = await connect(rabbit.url);
  }, 180_000);

  afterAll(async () => {
    await admin?.close();
    await rabbit?.stop();
  });

  async function bootApp(): Promise<INestApplicationContext> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MetricsServerModule.forRoot({
          serviceName: 'video-worker',
          version: 'int',
          port: 0,
          host: '127.0.0.1',
        }),
        MessagingModule.forRootAsync({
          useFactory: () => ({
            url: rabbit.url,
            connectionName: 'video-worker',
            topology: { retryDelaysMs: [300, 600, 900] },
            shutdownTimeoutMs: 10_000,
          }),
        }),
      ],
      providers: [VideoUploadedConsumer],
    }).compile();
    return moduleRef.init();
  }

  it('declara a topologia no boot, consome, publica o resultado e expõe a métrica', async () => {
    const app = await bootApp();
    try {
      await app.get(TopologyInitializer).whenReady();
      const consumers = app.get(MessageConsumers);
      await waitFor(() => consumers.all[0]?.isConsuming, { description: 'consumer ativo' });

      const event = createEvent('video.uploaded', videoUploadedFixture.payload, 'cid-modulo-001');
      await app.get<EventPublisher>(EVENT_PUBLISHER).publishEvent(event);

      const consumer = app.get(VideoUploadedConsumer);
      await waitFor(() => consumer.handled.length === 1);
      expect(consumer.handled[0]).toEqual({ id: event.id, correlationId: 'cid-modulo-001' });

      const channel = await admin.createChannel();
      const started = (await waitFor(() =>
        channel.get(QUEUES.apiVideoProcessing, { noAck: true }),
      )) as GetMessage;
      await channel.close();
      const startedEvent = processingStartedEvent.parse(JSON.parse(started.content.toString()));
      expect(startedEvent.correlationId).toBe('cid-modulo-001');
      expect(started.properties.appId).toBe('video-worker');

      const port = app.get(MetricsServerService).server.port;
      const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      expect(metrics).toContain(
        'fiapx_messages_consumed_total{queue="worker.video-uploaded",result="success",service="video-worker"} 1',
      );
    } finally {
      await app.close();
    }
  });

  it('graceful shutdown: para de consumir e termina a mensagem em processamento antes de fechar', async () => {
    const app = await bootApp();
    const consumer = app.get(VideoUploadedConsumer);
    consumer.processingDelayMs = 1_500;
    const consumers = app.get(MessageConsumers);
    await waitFor(() => consumers.all[0]?.isConsuming, { description: 'consumer ativo' });

    const event = createEvent('video.uploaded', videoUploadedFixture.payload, 'cid-shutdown');
    await app.get<EventPublisher>(EVENT_PUBLISHER).publishEvent(event);
    await waitFor(() => consumers.all[0]?.inFlightCount === 1, { description: 'em processamento' });

    const startedAt = Date.now();
    await app.close(); // SIGTERM → onModuleDestroy (consumers) → onApplicationShutdown (conexão)

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
    expect(consumer.handled.map((h) => h.id)).toEqual([event.id]);
    const channel = await admin.createChannel();
    const queue = await channel.checkQueue(QUEUES.workerVideoUploaded);
    await channel.close();
    expect(queue.messageCount).toBe(0); // confirmada antes do shutdown: nada é reentregue
  });
});
