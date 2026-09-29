import { EVENT_TYPES } from '@fiapx/contracts';
import {
  buildTopology,
  deadLetterQueueName,
  DELIVERY_LIMIT,
  EXCHANGES,
  MAIN_QUEUE_BINDINGS,
  mainQueueArguments,
  MAX_RETRIES,
  QUEUES,
  RETRY_DELAYS_MS,
  retryQueueArguments,
  retryQueueName,
  ROUTING_KEYS,
} from './topology';

describe('topologia RabbitMQ (contratos.md, seção 2)', () => {
  it('trava os argumentos das filas principais', () => {
    expect(mainQueueArguments(QUEUES.workerVideoUploaded)).toEqual({
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'fiapx.dlx',
      'x-dead-letter-routing-key': 'worker.video-uploaded',
      'x-dead-letter-strategy': 'at-least-once',
      'x-overflow': 'reject-publish',
    });
    expect(DELIVERY_LIMIT).toBe(5);
  });

  it('filas de retry têm TTL fixo por nível (5 s, 30 s, 2 min) e voltam à fila original', () => {
    expect(RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000]);
    expect(MAX_RETRIES).toBe(3);
    expect(retryQueueArguments('worker.video-uploaded', 2)).toEqual({
      'x-queue-type': 'quorum',
      'x-message-ttl': 30_000,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': 'worker.video-uploaded',
      'x-dead-letter-strategy': 'at-least-once',
      'x-overflow': 'reject-publish',
    });
  });

  it('nomeia filas de retry e DLQ', () => {
    expect(retryQueueName('notification.events', 1)).toBe('notification.events.retry.1');
    expect(retryQueueName('notification.events', 3)).toBe('notification.events.retry.3');
    expect(deadLetterQueueName('notification.events')).toBe('notification.events.dlq');
  });

  it.each([0, 4, 1.5, -1])('rejeita nível de retry inválido %p', (level) => {
    expect(() => retryQueueName('q', level)).toThrow(RangeError);
    expect(() => retryQueueArguments('q', level)).toThrow(RangeError);
  });

  it('liga as filas principais conforme o contrato', () => {
    const routing = (queue: keyof typeof MAIN_QUEUE_BINDINGS) =>
      MAIN_QUEUE_BINDINGS[queue].map((b) => `${b.exchange}/${b.routingKey}`);

    expect(routing(QUEUES.workerVideoUploaded)).toEqual(['fiapx.events/video.uploaded']);
    expect(routing(QUEUES.apiVideoProcessing)).toEqual(['fiapx.events/video.processing.*']);
    expect(routing(QUEUES.apiVideoDeadLetter)).toEqual(['fiapx.dlx/worker.video-uploaded']);
    expect(routing(QUEUES.notificationEvents)).toEqual([
      'fiapx.events/video.failed',
      'fiapx.events/video.completed',
      'fiapx.events/user.deleted',
    ]);
  });

  it('as routing keys são exatamente os types de evento de @fiapx/contracts', () => {
    expect(ROUTING_KEYS).toBe(EVENT_TYPES);
    expect(Object.values(ROUTING_KEYS)).toEqual([
      'video.uploaded',
      'video.processing.started',
      'video.processing.completed',
      'video.processing.failed',
      'video.failed',
      'video.completed',
      'user.deleted',
    ]);
    expect(ROUTING_KEYS.userDeleted).toBe('user.deleted');
  });

  it('as routing keys de processamento casam com o binding video.processing.*', () => {
    const processing = Object.values(ROUTING_KEYS).filter((k) => k.startsWith('video.processing.'));
    expect(processing).toEqual([
      'video.processing.started',
      'video.processing.completed',
      'video.processing.failed',
    ]);
  });

  describe('buildTopology', () => {
    const topology = buildTopology();

    it('declara fiapx.events (topic) e fiapx.dlx (direct), duráveis', () => {
      expect(topology.exchanges).toEqual([
        { name: EXCHANGES.events, type: 'topic', durable: true },
        { name: EXCHANGES.deadLetter, type: 'direct', durable: true },
      ]);
    });

    it('cria principal + 3 retries + DLQ para cada fila (20 filas quorum)', () => {
      expect(topology.queues).toHaveLength(Object.keys(QUEUES).length * (1 + MAX_RETRIES + 1));
      expect(topology.queues.every((q) => q.arguments['x-queue-type'] === 'quorum')).toBe(true);
      expect(topology.queues.every((q) => q.durable)).toBe(true);
      expect(topology.queues.map((q) => q.name)).toEqual(
        expect.arrayContaining([
          'worker.video-uploaded',
          'worker.video-uploaded.retry.3',
          'worker.video-uploaded.dlq',
          'api.video-deadletter.dlq',
          'notification.events.retry.1',
        ]),
      );
    });

    it('liga cada DLQ ao fiapx.dlx pela routing key da fila de origem', () => {
      expect(topology.bindings).toEqual(
        expect.arrayContaining([
          {
            queue: 'worker.video-uploaded.dlq',
            exchange: 'fiapx.dlx',
            routingKey: 'worker.video-uploaded',
          },
          {
            queue: 'api.video-deadletter',
            exchange: 'fiapx.dlx',
            routingKey: 'worker.video-uploaded',
          },
          {
            queue: 'notification.events.dlq',
            exchange: 'fiapx.dlx',
            routingKey: 'notification.events',
          },
        ]),
      );
      expect(topology.bindings).toHaveLength(6 + 4); // 6 bindings principais + 4 DLQs
    });

    it('snapshot: todos os bindings, na ordem de declaração', () => {
      expect(topology.bindings.map((b) => `${b.exchange} --${b.routingKey}--> ${b.queue}`)).toEqual(
        [
          'fiapx.events --video.uploaded--> worker.video-uploaded',
          'fiapx.dlx --worker.video-uploaded--> worker.video-uploaded.dlq',
          'fiapx.events --video.processing.*--> api.video-processing',
          'fiapx.dlx --api.video-processing--> api.video-processing.dlq',
          'fiapx.dlx --worker.video-uploaded--> api.video-deadletter',
          'fiapx.dlx --api.video-deadletter--> api.video-deadletter.dlq',
          'fiapx.events --video.failed--> notification.events',
          'fiapx.events --video.completed--> notification.events',
          'fiapx.events --user.deleted--> notification.events',
          'fiapx.dlx --notification.events--> notification.events.dlq',
        ],
      );
    });

    it('user.deleted só chega em notification.events (nenhuma outra fila recebe)', () => {
      const targets = topology.bindings
        .filter((b) => b.exchange === EXCHANGES.events && b.routingKey === 'user.deleted')
        .map((b) => b.queue);
      expect(targets).toEqual([QUEUES.notificationEvents]);
      expect('user.deleted'.startsWith('video.processing.')).toBe(false);
    });

    it('filas de retry não têm binding (publicação direta pela default exchange)', () => {
      expect(topology.bindings.some((b) => b.queue.includes('.retry.'))).toBe(false);
    });
  });

  describe('TTLs de retry customizados (só testes de integração)', () => {
    it('buildTopology aplica os TTLs informados nas filas .retry.N', () => {
      const topology = buildTopology({ retryDelaysMs: [100, 200, 300] });
      const ttl = (name: string) =>
        topology.queues.find((q) => q.name === name)?.arguments['x-message-ttl'];
      expect(ttl('notification.events.retry.1')).toBe(100);
      expect(ttl('notification.events.retry.3')).toBe(300);
      expect(retryQueueArguments('q', 2, [1, 2, 3])['x-message-ttl']).toBe(2);
    });

    it.each([[[1, 2]], [[1, 2, 0]], [[1, 2, 3.5]], [[1, 2, 3, 4]]])(
      'rejeita retryDelaysMs inválido %p',
      (delays) => {
        expect(() => buildTopology({ retryDelaysMs: delays })).toThrow(RangeError);
      },
    );
  });
});
