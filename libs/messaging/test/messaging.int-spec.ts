import { randomUUID } from 'node:crypto';
import { DependencyUnavailableError, ProcessingErrors, RetryableError } from '@fiapx/common';
import type { VideoUploadedEvent } from '@fiapx/contracts';
import { createEvent, notificationEvent, videoUploadedEvent } from '@fiapx/contracts';
import {
  FIXTURE_USER_ID,
  videoCompletedFixture,
  videoFailedFixture,
  videoUploadedFixture,
} from '@fiapx/contracts/fixtures';
import { getCorrelationId } from '@fiapx/observability';
import type { StartedRabbitMq } from '@fiapx/testing';
import { delay, quietNestLogs, startRabbitMq, waitFor } from '@fiapx/testing';
import { Registry } from '@prometheus-io/client';
import type { Channel, ChannelModel, GetMessage } from 'amqplib';
import { connect } from 'amqplib';
import type {
  ConsumeResult,
  ConsumerDefinition,
  ConsumerRunnerDependencies,
  MessageContext,
} from '../src';
import {
  AmqpConnection,
  buildTopology,
  ConsumerRunner,
  deadLetterQueueName,
  EXCHANGES,
  MessagePublisher,
  MessagingMetrics,
  QUEUES,
  retryQueueName,
  setupTopology,
  UnroutableMessageError,
} from '../src';
import { InvalidEventError, PublishError } from '../src/messaging.errors';

/**
 * Integração com RabbitMQ REAL (mesma imagem do compose, via Testcontainers).
 *
 * TTLs das filas `.retry.N` encurtados só aqui (broker descartável): 400 ms, 800 ms, 1600 ms.
 * Produção usa os do contrato (5 s, 30 s, 2 min).
 */
const RETRY_DELAYS_MS = [400, 800, 1600] as const;
const QUEUE = QUEUES.workerVideoUploaded;
const QUEUE_FAMILY = [
  QUEUE,
  retryQueueName(QUEUE, 1),
  retryQueueName(QUEUE, 2),
  retryQueueName(QUEUE, 3),
  deadLetterQueueName(QUEUE),
  QUEUES.apiVideoDeadLetter,
  retryQueueName(QUEUES.apiVideoDeadLetter, 1),
  deadLetterQueueName(QUEUES.apiVideoDeadLetter),
  QUEUES.apiVideoProcessing,
  QUEUES.notificationEvents,
];

interface Harness {
  connection: AmqpConnection;
  publisher: MessagePublisher;
  metrics: MessagingMetrics;
  registry: Registry;
  runners: ConsumerRunner<typeof videoUploadedEvent>[];
}

describe('libs/messaging com RabbitMQ real', () => {
  let rabbit: StartedRabbitMq;
  let admin: ChannelModel;
  let inspect: Channel;
  const harnesses: Harness[] = [];

  beforeAll(async () => {
    quietNestLogs();
    rabbit = await startRabbitMq();
    await setupTopology({
      url: rabbit.url,
      topology: buildTopology({ retryDelaysMs: RETRY_DELAYS_MS }),
    });
    admin = await connect(rabbit.url);
    inspect = await admin.createChannel();
  }, 180_000);

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await Promise.all(harness.runners.map((runner) => runner.stop(1_000)));
      await harness.publisher.close().catch(() => undefined);
      await harness.connection.close();
    }
    for (const queue of QUEUE_FAMILY) await inspect.purgeQueue(queue);
  });

  afterAll(async () => {
    await admin?.close();
    await rabbit?.stop();
  });

  function createHarness(name = 'int-test'): Harness {
    const connection = new AmqpConnection({
      url: rabbit.url,
      connectionName: name,
      reconnectTimeInSeconds: 1,
      channelRecoveryDelayMs: 200,
    });
    const publisher = new MessagePublisher(connection, { appId: name, confirmTimeoutMs: 3_000 });
    const registry = new Registry();
    const harness: Harness = {
      connection,
      publisher,
      registry,
      metrics: new MessagingMetrics(registry),
      runners: [],
    };
    harnesses.push(harness);
    return harness;
  }

  async function startConsumer(
    harness: Harness,
    definition: Omit<ConsumerDefinition<typeof videoUploadedEvent>, 'queue' | 'schema'>,
    options: {
      queue?: string;
      deps?: Partial<Omit<ConsumerRunnerDependencies, 'connection' | 'publisher'>>;
    } = {},
  ): Promise<ConsumerRunner<typeof videoUploadedEvent>> {
    const runner = new ConsumerRunner(
      { queue: options.queue ?? QUEUE, schema: videoUploadedEvent, ...definition },
      {
        connection: harness.connection,
        publisher: harness.publisher,
        metrics: harness.metrics,
        ...options.deps,
      },
    );
    harness.runners.push(runner);
    runner.start();
    await waitFor(() => runner.isConsuming, { description: 'consumer ativo' });
    return runner;
  }

  function newEvent(correlationId: string): VideoUploadedEvent {
    return createEvent('video.uploaded', videoUploadedFixture.payload, correlationId);
  }

  async function messageCount(queue: string): Promise<number> {
    return (await inspect.checkQueue(queue)).messageCount;
  }

  function consumedTotal(
    harness: Harness,
    result: ConsumeResult,
    queue: string = QUEUE,
  ): Promise<number> {
    return harness.metrics.consumedCount(queue, result);
  }

  it('(a) sucesso: handler recebe o evento validado no contexto de correlação e a mensagem é confirmada', async () => {
    const harness = createHarness();
    const received: { event: VideoUploadedEvent; context: MessageContext; alsId?: string }[] = [];
    await startConsumer(harness, {
      handle: (event, context) => {
        received.push({ event, context, alsId: getCorrelationId() });
        return Promise.resolve();
      },
    });

    const event = newEvent('cid-sucesso-001');
    await harness.publisher.publishEvent(event);

    await waitFor(() => received.length === 1, { description: 'handler chamado' });
    expect(received[0]?.event).toEqual(event);
    expect(received[0]?.alsId).toBe('cid-sucesso-001');
    expect(received[0]?.context).toMatchObject({
      queue: QUEUE,
      messageId: event.id,
      correlationId: 'cid-sucesso-001',
      retryCount: 0,
      deliveryCount: 0,
      redelivered: false,
    });
    await waitFor(async () => (await consumedTotal(harness, 'success')) === 1);
    await delay(300);
    expect(received).toHaveLength(1);
    expect(await messageCount(QUEUE)).toBe(0);
  });

  it('(b) regressão da Fase 4: falha transitória faz 3 retries com atraso crescente e cai na DLQ UMA vez', async () => {
    const harness = createHarness();
    const attempts: { at: number; retryCount: number; alsId?: string }[] = [];
    await startConsumer(harness, {
      handle: (_event, context) => {
        attempts.push({
          at: Date.now(),
          retryCount: context.retryCount,
          alsId: getCorrelationId(),
        });
        return Promise.reject(new RetryableError('storage fora do ar'));
      },
    });

    const event = newEvent('cid-retry-001');
    await harness.publisher.publishEvent(event);

    await waitFor(async () => (await messageCount(deadLetterQueueName(QUEUE))) === 1, {
      timeoutMs: 20_000,
      description: 'mensagem na worker.video-uploaded.dlq',
    });
    // Folga maior que o maior TTL: nada mais pode chegar (sem requeue infinito).
    await delay(RETRY_DELAYS_MS[2] + 1_000);

    expect(attempts.map((a) => a.retryCount)).toEqual([0, 1, 2, 3]);
    expect(attempts.every((a) => a.alsId === 'cid-retry-001')).toBe(true);
    const gaps = attempts.slice(1).map((a, i) => a.at - (attempts[i] as { at: number }).at);
    gaps.forEach((gap, i) => expect(gap).toBeGreaterThanOrEqual(RETRY_DELAYS_MS[i] - 50));
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
    expect(gaps[2]).toBeGreaterThan(gaps[1]);

    expect(await messageCount(deadLetterQueueName(QUEUE))).toBe(1);
    expect(await messageCount(QUEUES.apiVideoDeadLetter)).toBe(1);
    for (const queue of [QUEUE, ...[1, 2, 3].map((n) => retryQueueName(QUEUE, n))]) {
      expect(await messageCount(queue)).toBe(0);
    }

    const dead = (await inspect.get(deadLetterQueueName(QUEUE), { noAck: true })) as GetMessage;
    expect(JSON.parse(dead.content.toString())).toEqual(event);
    expect(dead.properties.messageId).toBe(event.id);
    expect(dead.properties.correlationId).toBe('cid-retry-001');
    expect(dead.properties.headers).toMatchObject({
      'x-retry-count': 3,
      'x-correlation-id': 'cid-retry-001',
      'x-last-error': 'RetryableError: Falha transitória: storage fora do ar',
      'x-last-death-reason': 'rejected',
      'x-last-death-queue': QUEUE,
    });

    expect(await consumedTotal(harness, 'retry')).toBe(3);
    expect(await consumedTotal(harness, 'dead_letter')).toBe(1);
  }, 60_000);

  it('(c) falha permanente: sem retry, onPermanentFailure publica o resultado e a mensagem é confirmada', async () => {
    const harness = createHarness();
    let handlerCalls = 0;
    const permanent: string[] = [];
    await startConsumer(harness, {
      handle: () => {
        handlerCalls += 1;
        return Promise.reject(ProcessingErrors.INVALID_VIDEO());
      },
      onPermanentFailure: async (event, error) => {
        permanent.push(error.appError.code);
        await harness.publisher.publishEvent(
          createEvent(
            'video.processing.failed',
            {
              videoId: event.payload.videoId,
              attempt: 1,
              errorCode: error.appError.code,
              errorMessage: error.appError.description,
            },
            event.correlationId,
          ),
        );
      },
    });

    await harness.publisher.publishEvent(newEvent('cid-permanente-001'));

    await waitFor(async () => (await consumedTotal(harness, 'permanent_failure')) === 1);
    await delay(RETRY_DELAYS_MS[0] + 500);
    expect(handlerCalls).toBe(1);
    expect(permanent).toEqual(['P0001']);
    expect(await messageCount(retryQueueName(QUEUE, 1))).toBe(0);
    expect(await messageCount(deadLetterQueueName(QUEUE))).toBe(0);

    const result = (await inspect.get(QUEUES.apiVideoProcessing, { noAck: true })) as GetMessage;
    expect(result.properties.type).toBe('video.processing.failed');
    expect(result.properties.correlationId).toBe('cid-permanente-001');
  });

  it('(c) envelope inválido: nack(requeue=false) direto para o DLX, handler nunca chamado', async () => {
    const harness = createHarness();
    let handlerCalls = 0;
    await startConsumer(harness, {
      handle: () => {
        handlerCalls += 1;
        return Promise.resolve();
      },
    });

    await harness.publisher.publish({
      exchange: EXCHANGES.events,
      routingKey: 'video.uploaded',
      content: Buffer.from('{"type":"video.uploaded","payload":{}}'),
      messageId: randomUUID(),
      correlationId: 'cid-invalido-001',
      type: 'video.uploaded',
    });

    await waitFor(async () => (await messageCount(deadLetterQueueName(QUEUE))) === 1);
    expect(handlerCalls).toBe(0);
    expect(await consumedTotal(harness, 'invalid')).toBe(1);
    const dead = (await inspect.get(deadLetterQueueName(QUEUE), { noAck: true })) as GetMessage;
    expect(dead.properties.headers?.['x-last-death-reason']).toBe('rejected');
  });

  it('(d) crash: canal fechado sem ack faz o broker reentregar a mensagem', async () => {
    const crashing = createHarness('int-test-crash');
    let firstCalls = 0;
    await startConsumer(crashing, {
      handle: () => {
        firstCalls += 1;
        return new Promise<void>(() => undefined); // nunca termina: simula processo travado
      },
    });
    const event = newEvent('cid-crash-001');
    await crashing.publisher.publishEvent(event);
    await waitFor(() => firstCalls === 1, { description: 'primeira entrega' });

    // "Crash": a conexão cai com a mensagem sem ack.
    harnesses.splice(harnesses.indexOf(crashing), 1);
    await crashing.connection.close();

    const survivor = createHarness('int-test-survivor');
    const redelivered: MessageContext[] = [];
    await startConsumer(survivor, {
      handle: (_event, context) => {
        redelivered.push(context);
        return Promise.resolve();
      },
    });

    await waitFor(() => redelivered.length === 1, { description: 'reentrega' });
    expect(redelivered[0]).toMatchObject({ messageId: event.id, redelivered: true });
    // RabbitMQ 4.3: canal/conexão fechado com mensagem pendente conta como entrega falha.
    expect(redelivered[0]?.deliveryCount).toBe(1);
    await waitFor(async () => (await consumedTotal(survivor, 'success')) === 1);
    expect(await messageCount(QUEUE)).toBe(0);
  });

  it('(d) poison message: crash a cada entrega termina no DLX por delivery_limit (sem loop infinito)', async () => {
    const harness = createHarness();
    await harness.publisher.publishEvent(newEvent('cid-poison-001'));

    const deliveryCounts: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      if ((await messageCount(deadLetterQueueName(QUEUE))) > 0) break;
      const channel = await admin.createChannel();
      await channel.prefetch(1);
      const delivered = new Promise<number>((resolve) => {
        void channel.consume(QUEUE, (message) => {
          resolve(Number(message?.properties.headers?.['x-delivery-count'] ?? 0));
        });
      });
      const count = await Promise.race([delivered, delay(3_000).then(() => -1)]);
      await channel.close(); // sem ack: "crash"
      if (count < 0) break;
      deliveryCounts.push(count);
    }

    await waitFor(async () => (await messageCount(deadLetterQueueName(QUEUE))) === 1);
    // x-delivery-limit=5: 1 entrega original + 5 devoluções = 6 entregas, depois DLX.
    expect(deliveryCounts).toEqual([0, 1, 2, 3, 4, 5]);
    const dead = (await inspect.get(deadLetterQueueName(QUEUE), { noAck: true })) as GetMessage;
    expect(dead.properties.headers?.['x-last-death-reason']).toBe('delivery_limit');
    expect(await messageCount(QUEUES.apiVideoDeadLetter)).toBe(1);
  }, 60_000);

  describe('(e) publisher confirms', () => {
    it('publishEvent resolve após o confirm com todas as propriedades do contrato', async () => {
      const harness = createHarness('video-api');
      const event = newEvent('cid-confirm-001');

      await harness.publisher.publishEvent(event);

      expect(await messageCount(QUEUE)).toBe(1);
      const message = (await inspect.get(QUEUE, { noAck: true })) as GetMessage;
      expect(message.fields.routingKey).toBe('video.uploaded');
      expect(message.fields.exchange).toBe('fiapx.events');
      expect(message.properties).toMatchObject({
        contentType: 'application/json',
        deliveryMode: 2,
        messageId: event.id,
        correlationId: 'cid-confirm-001',
        type: 'video.uploaded',
        appId: 'video-api',
        timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
        headers: { 'x-correlation-id': 'cid-confirm-001' },
      });
      expect(videoUploadedEvent.parse(JSON.parse(message.content.toString()))).toEqual(event);
    });

    it('notification.events recebe video.failed, video.completed e user.deleted (LGPD, seção 12)', async () => {
      const harness = createHarness('video-api');
      const events = [
        createEvent('video.failed', videoFailedFixture.payload, 'cid-notif-1'),
        createEvent('video.completed', videoCompletedFixture.payload, 'cid-notif-2'),
        createEvent('user.deleted', { userId: FIXTURE_USER_ID }, 'cid-notif-3'),
      ];

      for (const event of events) await harness.publisher.publishEvent(event);

      expect(await messageCount(QUEUES.notificationEvents)).toBe(3);
      const received: string[] = [];
      for (let i = 0; i < events.length; i += 1) {
        const message = (await inspect.get(QUEUES.notificationEvents, {
          noAck: true,
        })) as GetMessage;
        const parsed = notificationEvent.parse(JSON.parse(message.content.toString()));
        received.push(parsed.type);
        expect(message.fields.routingKey).toBe(parsed.type);
      }
      expect(received).toEqual(['video.failed', 'video.completed', 'user.deleted']);
      // Nenhuma outra fila ligada ao fiapx.events recebe o user.deleted.
      expect(await messageCount(QUEUE)).toBe(0);
      expect(await messageCount(QUEUES.apiVideoProcessing)).toBe(0);
    });

    it('mensagem sem fila de destino rejeita com UnroutableMessageError (mandatory)', async () => {
      const harness = createHarness();
      const base = {
        content: Buffer.from('{}'),
        messageId: randomUUID(),
        correlationId: 'cid-sem-rota',
        type: 'x',
      };

      await expect(
        harness.publisher.publish({ ...base, exchange: EXCHANGES.events, routingKey: 'ninguem' }),
      ).rejects.toBeInstanceOf(UnroutableMessageError);
      await expect(
        harness.publisher.publish({
          ...base,
          messageId: randomUUID(),
          exchange: '',
          routingKey: 'fila-que-nao-existe',
        }),
      ).rejects.toBeInstanceOf(UnroutableMessageError);
    });

    it('envelope fora do contrato não é publicado', async () => {
      const harness = createHarness();
      const event = newEvent('cid-invalido');
      const bad = { ...event, payload: { ...event.payload, sizeBytes: 0 } };

      await expect(harness.publisher.publishEvent(bad)).rejects.toBeInstanceOf(InvalidEventError);
      expect(await messageCount(QUEUE)).toBe(0);
    });

    it('canal fechado pelo broker (exchange inexistente) é recuperado com reconexão forçada', async () => {
      const harness = createHarness();

      await expect(
        harness.publisher.publish({
          exchange: 'exchange.que.nao.existe',
          routingKey: 'x',
          content: Buffer.from('{}'),
          messageId: randomUUID(),
          correlationId: 'cid-404',
          type: 'x',
          timeoutMs: 1_500,
        }),
      ).rejects.toBeInstanceOf(PublishError);

      await waitFor(
        async () => {
          await harness.publisher.publishEvent(newEvent('cid-recuperado'));
          return true;
        },
        { timeoutMs: 20_000, description: 'publicação após a recuperação do canal' },
      );
      await waitFor(async () => (await messageCount(QUEUE)) >= 1);
    }, 40_000);
  });

  it('(f) regressão: mensagem vinda de dead-letter (x-retry-count=3) ganha retries novos em api.video-deadletter', async () => {
    const harness = createHarness('video-worker');
    await startConsumer(harness, {
      handle: () => Promise.reject(new RetryableError('garage fora')),
    });
    const event = newEvent('cid-dlx-retry-001');
    await harness.publisher.publishEvent(event);
    await waitFor(async () => (await messageCount(QUEUES.apiVideoDeadLetter)) === 1, {
      timeoutMs: 20_000,
      description: 'cópia em api.video-deadletter',
    });

    const api = createHarness('video-api');
    const contexts: MessageContext[] = [];
    await startConsumer(
      api,
      {
        handle: (_event, context) => {
          contexts.push(context);
          return contexts.length === 1
            ? Promise.reject(new RetryableError('postgres piscou'))
            : Promise.resolve();
        },
      },
      { queue: QUEUES.apiVideoDeadLetter },
    );

    await waitFor(
      async () => (await consumedTotal(api, 'success', QUEUES.apiVideoDeadLetter)) === 1,
      { timeoutMs: 10_000, description: 'sucesso depois de 1 retry' },
    );
    expect(contexts.map((c) => [c.retryCount, c.deathReason])).toEqual([
      [0, 'rejected'],
      [1, 'rejected'],
    ]);
    expect(await consumedTotal(api, 'retry', QUEUES.apiVideoDeadLetter)).toBe(1);
    expect(await consumedTotal(api, 'dead_letter', QUEUES.apiVideoDeadLetter)).toBe(0);
    expect(await messageCount(deadLetterQueueName(QUEUES.apiVideoDeadLetter))).toBe(0);
  }, 60_000);

  it('(g) dependência fora: devolve sem gastar retry nem delivery-limit e pausa até voltar', async () => {
    const harness = createHarness();
    const deliveries: MessageContext[] = [];
    const runner = await startConsumer(
      harness,
      {
        handle: (_event, context) => {
          deliveries.push(context);
          return deliveries.length <= 2
            ? Promise.reject(new DependencyUnavailableError('postgres'))
            : Promise.resolve();
        },
      },
      { deps: { timings: { pauseInitialMs: 300, pauseMaxMs: 600 } } },
    );

    await harness.publisher.publishEvent(newEvent('cid-dependencia-001'));

    await waitFor(async () => (await consumedTotal(harness, 'success')) === 1, {
      timeoutMs: 15_000,
      description: 'sucesso depois de a dependência voltar',
    });
    expect(deliveries.map((d) => d.retryCount)).toEqual([0, 0, 0]);
    // nack(requeue=true) não conta no x-delivery-limit (RabbitMQ 4.3): nada de DLX por pausar.
    expect(deliveries.map((d) => d.deliveryCount)).toEqual([0, 0, 0]);
    expect(await consumedTotal(harness, 'deferred')).toBe(2);
    expect(await consumedTotal(harness, 'retry')).toBe(0);
    expect(await messageCount(retryQueueName(QUEUE, 1))).toBe(0);
    expect(await messageCount(deadLetterQueueName(QUEUE))).toBe(0);
    expect(runner.isConsuming).toBe(true);
  }, 30_000);

  it('(h) canal fechado no meio do job: nada é confirmado nem publicado e a reentrega espera o job antigo', async () => {
    const harness = createHarness();
    const log: string[] = [];
    let calls = 0;
    await startConsumer(harness, {
      handle: async (_event, context) => {
        calls += 1;
        const call = calls;
        log.push(`inicio-${call}`);
        if (call === 1) {
          // Job longo que só termina quando o canal cai (como o ffmpeg morto pelo abort).
          await new Promise<void>((resolve) => {
            context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          await delay(300);
          log.push(`fim-${call}`);
          throw new RetryableError('ffmpeg morto pelo abort');
        }
        log.push(`fim-${call}`);
      },
    });

    await harness.publisher.publishEvent(newEvent('cid-abort-001'));
    await waitFor(() => calls === 1, { description: 'primeira entrega' });

    harness.connection.manager.reconnect();

    await waitFor(async () => (await consumedTotal(harness, 'success')) === 1, {
      timeoutMs: 20_000,
      description: 'reentrega processada',
    });
    expect(log).toEqual(['inicio-1', 'fim-1', 'inicio-2', 'fim-2']);
    expect(await consumedTotal(harness, 'aborted')).toBe(1);
    expect(await consumedTotal(harness, 'retry')).toBe(0);
    expect(await messageCount(retryQueueName(QUEUE, 1))).toBe(0);
    expect(await messageCount(QUEUE)).toBe(0);
  }, 40_000);

  it('(i) consumer cancelado pelo broker (fila apagada e recriada) volta sozinho', async () => {
    const harness = createHarness();
    const received: string[] = [];
    const topology = buildTopology({ retryDelaysMs: RETRY_DELAYS_MS });
    const runner = await startConsumer(
      harness,
      {
        handle: (event) => {
          received.push(event.correlationId);
          return Promise.resolve();
        },
      },
      {
        deps: {
          ensureTopology: () => setupTopology({ url: rabbit.url, topology }).then(() => undefined),
          timings: { resubscribeInitialMs: 200 },
        },
      },
    );

    await inspect.deleteQueue(QUEUE);
    await waitFor(() => !runner.isConsuming, { description: 'consumer cancelado' });
    await waitFor(() => runner.isConsuming, {
      timeoutMs: 15_000,
      description: 'consumer re-assinado',
    });

    await harness.publisher.publishEvent(newEvent('cid-reassinado-001'));
    await waitFor(() => received.includes('cid-reassinado-001'), {
      description: 'mensagem consumida depois de re-assinar',
    });
    expect(runner.isHealthy).toBe(true);
  }, 30_000);

  it('a topologia é idempotente: declarar de novo não falha', async () => {
    await expect(
      setupTopology({
        url: rabbit.url,
        topology: buildTopology({ retryDelaysMs: RETRY_DELAYS_MS }),
      }),
    ).resolves.toBeDefined();
  });

  it('mudar argumento de fila existente falha com PRECONDITION_FAILED (exige migração)', async () => {
    await expect(setupTopology({ url: rabbit.url })).rejects.toThrow(/PRECONDITION_FAILED/);
  });
});
