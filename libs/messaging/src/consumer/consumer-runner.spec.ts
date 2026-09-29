import { DependencyUnavailableError, ProcessingErrors, RetryableError } from '@fiapx/common';
import { videoUploadedEvent } from '@fiapx/contracts';
import { videoUploadedFixture } from '@fiapx/contracts/fixtures';
import { getCorrelationId } from '@fiapx/observability';
import { Registry } from '@prometheus-io/client';
import {
  consumeMessage,
  FakeChannel,
  fakeConnectFn,
  silentLogger,
} from '../../test/fakes/fake-amqp';
import { AmqpConnection } from '../connection/amqp-connection';
import { MessagingMetrics } from '../messaging.metrics';
import type { OutgoingMessage } from '../publisher/message-publisher';
import type { ConsumerDefinition, MessageContext } from './consumer.types';
import type { ConsumerRunnerDependencies } from './consumer-runner';
import { ConsumerRunner, isDependencyOutage } from './consumer-runner';

type Definition = ConsumerDefinition<typeof videoUploadedEvent>;
const QUEUE = 'worker.video-uploaded';

function setup(
  definition: Partial<Definition> = {},
  deps: Partial<Omit<ConsumerRunnerDependencies, 'connection' | 'publisher'>> = {},
) {
  const { manager, connectFn } = fakeConnectFn();
  const connection = new AmqpConnection(
    { url: 'amqp://x', connectionName: 'worker', logger: silentLogger() },
    connectFn,
  );
  const publisher = { publish: jest.fn((_message: OutgoingMessage) => Promise.resolve()) };
  const metrics = new MessagingMetrics(new Registry());
  const logger = silentLogger();
  const handle = jest.fn((_event: unknown, _context: MessageContext) => Promise.resolve());
  const runner = new ConsumerRunner<typeof videoUploadedEvent>(
    { queue: QUEUE, schema: videoUploadedEvent, handle, ...definition },
    { connection, publisher, metrics, logger, ...deps },
  );
  const channel = new FakeChannel();
  return { manager, runner, publisher, metrics, logger, handle, channel };
}

describe('ConsumerRunner', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejeita prefetch inválido', () => {
    expect(() => setup({ prefetch: 0 })).toThrow(RangeError);
    expect(() => setup({ prefetch: 1.5 })).toThrow(RangeError);
  });

  it('usa o logger padrão quando nenhum é informado', () => {
    const { manager, connectFn } = fakeConnectFn();
    const connection = new AmqpConnection(
      { url: 'amqp://x', connectionName: 'w', logger: silentLogger() },
      connectFn,
    );
    const runner = new ConsumerRunner(
      { queue: QUEUE, schema: videoUploadedEvent, handle: () => Promise.resolve() },
      { connection, publisher: { publish: () => Promise.resolve() } },
    );
    expect(runner.queue).toBe(QUEUE);
    expect(manager.wrappers).toHaveLength(0);
  });

  describe('start', () => {
    it('consome num canal sem confirm, com prefetch, depois do beforeConsume', async () => {
      const order: string[] = [];
      const { runner, manager, channel } = setup(
        { prefetch: 5 },
        {
          beforeConsume: () => {
            order.push('beforeConsume');
            return Promise.resolve();
          },
        },
      );
      channel.prefetch.mockImplementation(() => {
        order.push('prefetch');
        return Promise.resolve();
      });

      runner.start();
      const wrapper = manager.wrappers[0];
      expect(wrapper.options).toMatchObject({ name: `consumer:${QUEUE}`, confirm: false });
      expect(runner.isConsuming).toBe(false);
      await wrapper.connect(channel);

      expect(order).toEqual(['beforeConsume', 'prefetch']);
      expect(channel.prefetch).toHaveBeenCalledWith(5);
      expect(channel.consume).toHaveBeenCalledWith(QUEUE, expect.any(Function), { noAck: false });
      expect(runner.isConsuming).toBe(true);
    });

    it('não inicia duas vezes', () => {
      const { runner } = setup();
      runner.start();
      expect(() => runner.start()).toThrow('já iniciado');
    });

    it('não consome se o stop aconteceu antes do setup', async () => {
      const { runner, manager, channel } = setup();
      runner.start();
      const wrapper = manager.wrappers[0];
      await runner.stop();

      await wrapper.connect(channel);

      expect(channel.consume).not.toHaveBeenCalled();
    });
  });

  describe('handleDelivery', () => {
    it('sucesso: handler recebe evento e contexto dentro do correlation id, depois ack', async () => {
      const { runner, handle, channel, metrics } = setup();
      let alsId: string | undefined;
      handle.mockImplementation(() => {
        alsId = getCorrelationId();
        return Promise.resolve();
      });
      const message = consumeMessage(videoUploadedFixture, {
        headers: { 'x-retry-count': 2, 'x-delivery-count': 1 },
        redelivered: true,
      });

      await expect(runner.handleDelivery(channel, message)).resolves.toBe('success');

      expect(handle).toHaveBeenCalledWith(videoUploadedFixture, {
        queue: QUEUE,
        messageId: videoUploadedFixture.id,
        correlationId: videoUploadedFixture.correlationId,
        retryCount: 2,
        deliveryCount: 1,
        redelivered: true,
        deathReason: undefined,
        headers: { 'x-retry-count': 2, 'x-delivery-count': 1 },
        signal: expect.any(AbortSignal),
      });
      expect(alsId).toBe(videoUploadedFixture.correlationId);
      expect(channel.ack).toHaveBeenCalledWith(message);
      expect(await metrics.consumedCount(QUEUE, 'success')).toBe(1);
    });

    it('contexto: messageId cai para event.id e deathReason vem do x-death', async () => {
      const { runner, handle, channel } = setup();
      const message = consumeMessage(videoUploadedFixture, {
        properties: { messageId: undefined, headers: { 'x-last-death-reason': 'delivery_limit' } },
      });

      await runner.handleDelivery(channel, message);

      expect(handle.mock.calls[0]?.[1]).toMatchObject({
        messageId: videoUploadedFixture.id,
        deathReason: 'delivery_limit',
      });
    });

    it('envelope inválido: nack sem requeue (DLX), sem chamar o handler', async () => {
      const { runner, handle, channel, logger, metrics } = setup();
      const message = consumeMessage(Buffer.from('{nao-json'), {
        properties: { correlationId: undefined, messageId: 'm-1' },
        headers: { 'x-correlation-id': 'cid-header' },
      });

      await expect(runner.handleDelivery(channel, message)).resolves.toBe('invalid');

      expect(handle).not.toHaveBeenCalled();
      expect(channel.nack).toHaveBeenCalledWith(message, false, false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'm-1', reason: expect.any(String) }),
      );
      expect(await metrics.consumedCount(QUEUE, 'invalid')).toBe(1);
    });

    it('envelope inválido sem nenhum correlation id também vai para o DLX', async () => {
      const { runner, channel } = setup();
      const message = consumeMessage(
        { ...videoUploadedFixture, payload: {} },
        { properties: { correlationId: undefined } },
      );

      await expect(runner.handleDelivery(channel, message)).resolves.toBe('invalid');
      expect(channel.nack).toHaveBeenCalledWith(message, false, false);
    });

    it('RetryableError: publica cópia na .retry.1 (confirm) e só então dá ack', async () => {
      const { runner, handle, channel, publisher, metrics } = setup({
        retryPublishTimeoutMs: 1_000,
      });
      handle.mockRejectedValue(new RetryableError('storage fora'));
      const order: string[] = [];
      publisher.publish.mockImplementation(() => {
        order.push('publish');
        return Promise.resolve();
      });
      channel.ack.mockImplementation(() => order.push('ack'));
      const message = consumeMessage(videoUploadedFixture, {
        headers: {
          'x-correlation-id': videoUploadedFixture.correlationId,
          'x-death': [{ queue: 'worker.video-uploaded.retry.1', reason: 'expired' }],
          'x-last-death-reason': 'expired',
          'x-delivery-count': 0,
        },
      });

      await expect(runner.handleDelivery(channel, message)).resolves.toBe('retry');

      expect(order).toEqual(['publish', 'ack']);
      expect(publisher.publish).toHaveBeenCalledWith({
        exchange: '',
        routingKey: 'worker.video-uploaded.retry.1',
        content: message.content,
        messageId: videoUploadedFixture.id,
        correlationId: videoUploadedFixture.correlationId,
        type: 'video.uploaded',
        headers: {
          'x-correlation-id': videoUploadedFixture.correlationId,
          'x-retry-count': 1,
          'x-last-error': 'RetryableError: Falha transitória: storage fora',
        },
        timestampMs: 1_760_097_600_000,
        timeoutMs: 1_000,
      });
      expect(await metrics.consumedCount(QUEUE, 'retry')).toBe(1);
    });

    it('erro desconhecido é tratado como transitório; nível segue o x-retry-count', async () => {
      const { runner, handle, channel, publisher } = setup();
      handle.mockRejectedValue(new Error('boom'));
      const message = consumeMessage(videoUploadedFixture, {
        headers: { 'x-retry-count': 2 },
        properties: { type: undefined, timestamp: undefined },
      });

      await expect(runner.handleDelivery(channel, message)).resolves.toBe('retry');

      const published = publisher.publish.mock.calls[0]?.[0];
      expect(published).toMatchObject({
        routingKey: 'worker.video-uploaded.retry.3',
        type: 'video.uploaded',
        timestampMs: undefined,
        headers: { 'x-retry-count': 3, 'x-last-error': 'Error: boom' },
      });
    });

    it('retries esgotados (x-retry-count=3): nack sem requeue → DLX, sem nova cópia', async () => {
      const { runner, handle, channel, publisher, metrics } = setup();
      handle.mockRejectedValue(new RetryableError('ainda fora'));
      const message = consumeMessage(videoUploadedFixture, { headers: { 'x-retry-count': 3 } });

      await expect(runner.handleDelivery(channel, message)).resolves.toBe('dead_letter');

      expect(publisher.publish).not.toHaveBeenCalled();
      expect(channel.nack).toHaveBeenCalledWith(message, false, false);
      expect(channel.ack).not.toHaveBeenCalled();
      expect(await metrics.consumedCount(QUEUE, 'dead_letter')).toBe(1);
    });

    it('cópia de retry sem confirm: reject(requeue=true), que conta no delivery-limit', async () => {
      const { runner, handle, channel, publisher } = setup();
      handle.mockRejectedValue(new RetryableError('x'));
      publisher.publish.mockRejectedValue(new Error('confirm timeout'));
      const message = consumeMessage(videoUploadedFixture);

      await expect(runner.handleDelivery(channel, message)).resolves.toBe('requeued');

      expect(channel.reject).toHaveBeenCalledWith(message, true);
      expect(channel.ack).not.toHaveBeenCalled();
    });

    it('NonRetryableError: onPermanentFailure e ack, sem retry', async () => {
      const onPermanentFailure = jest.fn(() => Promise.resolve());
      const { runner, handle, channel, publisher, metrics } = setup({ onPermanentFailure });
      const error = ProcessingErrors.INVALID_VIDEO('moov atom ausente');
      handle.mockRejectedValue(error);
      const message = consumeMessage(videoUploadedFixture);

      await expect(runner.handleDelivery(channel, message)).resolves.toBe('permanent_failure');

      expect(onPermanentFailure).toHaveBeenCalledWith(
        videoUploadedFixture,
        error,
        expect.objectContaining({ messageId: videoUploadedFixture.id }),
      );
      expect(channel.ack).toHaveBeenCalledWith(message);
      expect(publisher.publish).not.toHaveBeenCalled();
      expect(await metrics.consumedCount(QUEUE, 'permanent_failure')).toBe(1);
    });

    it('NonRetryableError sem onPermanentFailure: só registra e dá ack', async () => {
      const { runner, handle, channel, logger } = setup();
      handle.mockRejectedValue(ProcessingErrors.NO_FRAMES());

      await expect(
        runner.handleDelivery(channel, consumeMessage(videoUploadedFixture)),
      ).resolves.toBe('permanent_failure');
      expect(channel.ack).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: 'P0002' }));
    });

    it('se o onPermanentFailure falha, a mensagem segue o caminho de retry', async () => {
      const onPermanentFailure = jest.fn(() => Promise.reject(new Error('broker fora')));
      const { runner, handle, channel, publisher } = setup({ onPermanentFailure });
      handle.mockRejectedValue(ProcessingErrors.INVALID_VIDEO());

      await expect(
        runner.handleDelivery(channel, consumeMessage(videoUploadedFixture)),
      ).resolves.toBe('retry');
      expect(publisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-last-error': 'Error: broker fora' }),
        }),
      );
    });

    it('canal já fechado no ack: registra e deixa o broker reentregar', async () => {
      const { runner, channel, logger } = setup();
      channel.ack.mockImplementation(() => {
        throw new Error('Channel closed');
      });

      await expect(
        runner.handleDelivery(channel, consumeMessage(videoUploadedFixture)),
      ).resolves.toBe('success');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Error: Channel closed' }),
      );
    });
  });

  describe('entregas pelo consumer', () => {
    async function started(definition: Partial<Definition> = {}) {
      const ctx = setup(definition);
      ctx.runner.start();
      await ctx.manager.wrappers[0].connect(ctx.channel);
      return ctx;
    }

    it('processa cada entrega e acompanha as mensagens em processamento', async () => {
      const { runner, channel, handle } = await started();
      let release: () => void = () => undefined;
      handle.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      channel.onMessage?.(consumeMessage(videoUploadedFixture));
      await Promise.resolve();
      expect(runner.inFlightCount).toBe(1);

      release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(runner.inFlightCount).toBe(0);
      expect(channel.ack).toHaveBeenCalled();
    });

    it('consumer cancelado pelo broker (mensagem null) é re-assinado depois do backoff', async () => {
      jest.useFakeTimers();
      const ensureTopology = jest.fn(() => Promise.resolve());
      const ctx = setup({}, { ensureTopology });
      ctx.runner.start();
      await ctx.manager.wrappers[0].connect(ctx.channel);

      ctx.channel.onMessage?.(null);
      expect(ctx.runner.isConsuming).toBe(false);
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ queue: QUEUE }));

      await jest.advanceTimersByTimeAsync(1_000);
      expect(ensureTopology).toHaveBeenCalledTimes(1);
      expect(ctx.channel.consume).toHaveBeenCalledTimes(2);
      expect(ctx.runner.isConsuming).toBe(true);
    });

    it('erro inesperado fora do handler é registrado sem derrubar o processo', async () => {
      const { runner, channel, logger, metrics } = await started();
      jest.spyOn(metrics, 'consumed').mockImplementation(() => {
        throw new Error('registry quebrado');
      });

      channel.onMessage?.(consumeMessage(videoUploadedFixture));
      await new Promise((resolve) => setImmediate(resolve));

      expect(runner.inFlightCount).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Error: registry quebrado' }),
      );
    });

    it('stop: cancela o consumer, espera as mensagens em processamento e fecha o canal', async () => {
      const { runner, channel, handle, manager } = await started();
      const order: string[] = [];
      handle.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('handled');
      });
      channel.cancel.mockImplementation(() => {
        order.push('cancel');
        return Promise.resolve({});
      });
      channel.onMessage?.(consumeMessage(videoUploadedFixture));

      await runner.stop();
      await runner.stop(); // idempotente

      expect(order).toEqual(['cancel', 'handled']);
      expect(channel.ack).toHaveBeenCalled();
      expect(manager.wrappers[0]?.close).toHaveBeenCalledTimes(1);
      expect(runner.isConsuming).toBe(false);
    });

    it('stop: no timeout, avisa e fecha o canal mesmo com mensagem pendente', async () => {
      const { runner, channel, handle, logger } = await started({ shutdownTimeoutMs: 10 });
      handle.mockImplementation(() => new Promise<void>(() => undefined));
      channel.onMessage?.(consumeMessage(videoUploadedFixture));

      await runner.stop();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.stringContaining('ainda em processamento') }),
      );
    });

    it('stop: falha ao cancelar é registrada e o shutdown continua', async () => {
      const { runner, channel, logger, manager } = await started();
      channel.cancel.mockRejectedValue(new Error('canal fechado'));

      await runner.stop(50);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Error: canal fechado' }),
      );
      expect(manager.wrappers[0]?.close).toHaveBeenCalled();
    });

    it('stop usa o timeout padrão do módulo quando a definição não tem', async () => {
      jest.useFakeTimers();
      const ctx = setup({}, { shutdownTimeoutMs: 1_000 });
      ctx.runner.start();
      await ctx.manager.wrappers[0].connect(ctx.channel);
      ctx.handle.mockImplementation(() => new Promise<void>(() => undefined));
      ctx.channel.onMessage?.(consumeMessage(videoUploadedFixture));

      const stopping = ctx.runner.stop();
      await jest.advanceTimersByTimeAsync(1_000);
      await stopping;

      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.stringContaining('após 1000 ms') }),
      );
    });

    it('stop sem start não falha', async () => {
      const { runner } = setup();
      await expect(runner.stop()).resolves.toBeUndefined();
    });
  });

  describe('ciclo de retry por fila (mensagem vinda de dead-letter)', () => {
    it('regressão: x-retry-count herdado de outra fila não esgota os retries daqui', async () => {
      const { runner, handle, channel, publisher } = setup();
      handle.mockRejectedValue(new RetryableError('postgres piscou'));
      const message = consumeMessage(videoUploadedFixture, {
        headers: {
          'x-retry-count': 3,
          'x-last-death-reason': 'rejected',
          'x-death': [{ queue: 'worker.video-uploaded', reason: 'rejected' }],
        },
      });

      await expect(runner.handleDelivery(channel, message)).resolves.toBe('retry');

      expect(handle.mock.calls[0]?.[1]).toMatchObject({ retryCount: 0, deathReason: 'rejected' });
      expect(channel.nack).not.toHaveBeenCalled();
      expect(publisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          routingKey: 'worker.video-uploaded.retry.1',
          headers: expect.objectContaining({
            'x-retry-count': 1,
            'x-origin-death-reason': 'rejected',
          }) as unknown,
        }),
      );
      const headers = publisher.publish.mock.calls[0]?.[0].headers ?? {};
      expect(headers).not.toHaveProperty('x-death');
      expect(headers).not.toHaveProperty('x-last-death-reason');
    });

    it('depois do retry, o motivo de origem continua no contexto e a contagem segue', async () => {
      const { runner, handle, channel } = setup();
      const message = consumeMessage(videoUploadedFixture, {
        headers: {
          'x-retry-count': 1,
          'x-last-death-reason': 'expired',
          'x-origin-death-reason': 'delivery_limit',
        },
      });

      await runner.handleDelivery(channel, message);

      expect(handle.mock.calls[0]?.[1]).toMatchObject({
        retryCount: 1,
        deathReason: 'delivery_limit',
      });
    });
  });

  describe('dependência fora (regra 2b): devolve sem gastar retry e pausa', () => {
    async function started(deps: Partial<ConsumerRunnerDependencies> = {}) {
      jest.useFakeTimers();
      const ctx = setup({}, { timings: { pauseInitialMs: 100, pauseMaxMs: 250 }, ...deps });
      ctx.runner.start();
      await ctx.manager.wrappers[0].connect(ctx.channel);
      return ctx;
    }

    it('DependencyUnavailableError: nack(requeue=true), cancela o consumer e retoma com backoff', async () => {
      const { runner, handle, channel, publisher, metrics, logger } = await started();
      handle.mockRejectedValue(new DependencyUnavailableError('postgres'));
      const message = consumeMessage(videoUploadedFixture);

      await expect(runner.handleDelivery(channel, message)).resolves.toBe('deferred');

      expect(channel.nack).toHaveBeenCalledWith(message, false, true);
      expect(channel.reject).not.toHaveBeenCalled();
      expect(publisher.publish).not.toHaveBeenCalled();
      expect(channel.cancel).toHaveBeenCalledWith(`ctag-${QUEUE}`);
      expect(runner.isPaused).toBe(true);
      expect(runner.isConsuming).toBe(false);
      expect(runner.isHealthy).toBe(true);
      expect(await metrics.consumedCount(QUEUE, 'deferred')).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.stringContaining('pausado por 100 ms') }),
      );

      await jest.advanceTimersByTimeAsync(100);
      expect(runner.isPaused).toBe(false);
      expect(runner.isConsuming).toBe(true);
      expect(channel.consume).toHaveBeenCalledTimes(2);

      // Outra queda seguida: a pausa dobra (100 → 200 ms) até o teto.
      await runner.handleDelivery(channel, message);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.stringContaining('pausado por 200 ms') }),
      );
      await jest.advanceTimersByTimeAsync(200);
      await runner.handleDelivery(channel, message);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.stringContaining('pausado por 250 ms') }),
      );
      await jest.advanceTimersByTimeAsync(250);

      // Uma mensagem com sucesso zera o backoff.
      handle.mockResolvedValue(undefined);
      await runner.handleDelivery(channel, message);
      handle.mockRejectedValue(new DependencyUnavailableError('postgres'));
      await runner.handleDelivery(channel, message);
      expect(logger.warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ msg: expect.stringContaining('pausado por 100 ms') }),
      );
    });

    it('erro de conexão cru (ex.: ENOTFOUND do pg) também pausa', async () => {
      const { runner, handle, channel } = await started();
      handle.mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND postgres'), {
          code: 'ENOTFOUND',
        }),
      );

      await expect(
        runner.handleDelivery(channel, consumeMessage(videoUploadedFixture)),
      ).resolves.toBe('deferred');
    });

    it('entregas em andamento durante a pausa também voltam para a fila, sem nova pausa', async () => {
      const { runner, handle, channel, logger } = await started();
      handle.mockRejectedValue(new DependencyUnavailableError('storage'));

      await runner.handleDelivery(channel, consumeMessage(videoUploadedFixture));
      await runner.handleDelivery(channel, consumeMessage(videoUploadedFixture));

      expect(channel.nack).toHaveBeenCalledTimes(2);
      expect(channel.cancel).toHaveBeenCalledTimes(1);
      const pauses = logger.warn.mock.calls.filter(([entry]) =>
        String((entry as { msg?: string }).msg).includes('pausado'),
      );
      expect(pauses).toHaveLength(1);
    });

    it('onPermanentFailure que encontra a dependência fora também pausa', async () => {
      const onPermanentFailure = jest.fn(() =>
        Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
      );
      jest.useFakeTimers();
      const ctx = setup({ onPermanentFailure });
      ctx.runner.start();
      await ctx.manager.wrappers[0].connect(ctx.channel);
      ctx.handle.mockRejectedValue(ProcessingErrors.INVALID_VIDEO());

      await expect(
        ctx.runner.handleDelivery(ctx.channel, consumeMessage(videoUploadedFixture)),
      ).resolves.toBe('deferred');
      expect(ctx.channel.ack).not.toHaveBeenCalled();
    });

    it('falha ao cancelar o consumer na pausa só é registrada', async () => {
      const { runner, handle, channel, logger } = await started();
      channel.cancel.mockRejectedValue(new Error('canal fechado'));
      handle.mockRejectedValue(new DependencyUnavailableError('postgres'));

      await runner.handleDelivery(channel, consumeMessage(videoUploadedFixture));
      await Promise.resolve();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'Falha ao cancelar o consumer na pausa' }),
      );
    });

    it('reconexão durante a pausa não assina; o fim da pausa assina no canal novo', async () => {
      const { runner, handle, channel, manager } = await started();
      handle.mockRejectedValue(new DependencyUnavailableError('postgres'));
      await runner.handleDelivery(channel, consumeMessage(videoUploadedFixture));

      channel.emit('close');
      const fresh = new FakeChannel();
      await manager.wrappers[0].connect(fresh);
      expect(fresh.consume).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(100);
      expect(fresh.consume).toHaveBeenCalledTimes(1);
      expect(runner.isConsuming).toBe(true);
    });

    it('fim da pausa com o canal morto não faz nada (a reconexão assina)', async () => {
      const { runner, handle, channel } = await started();
      handle.mockRejectedValue(new DependencyUnavailableError('postgres'));
      await runner.handleDelivery(channel, consumeMessage(videoUploadedFixture));
      channel.emit('close');

      await jest.advanceTimersByTimeAsync(100);

      expect(channel.consume).toHaveBeenCalledTimes(1);
      expect(runner.isPaused).toBe(false);
    });

    it('falha ao retomar agenda nova tentativa de assinar', async () => {
      const { runner, handle, channel, logger } = await started({
        timings: { pauseInitialMs: 100, resubscribeInitialMs: 50 },
      });
      handle.mockRejectedValue(new DependencyUnavailableError('postgres'));
      await runner.handleDelivery(channel, consumeMessage(videoUploadedFixture));
      channel.consume.mockRejectedValueOnce(new Error('ACCESS_REFUSED'));

      await jest.advanceTimersByTimeAsync(100);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'Falha ao retomar o consumo; nova tentativa em breve' }),
      );
      await jest.advanceTimersByTimeAsync(50);
      expect(runner.isConsuming).toBe(true);
    });

    it('stop durante a pausa cancela a retomada', async () => {
      const { runner, handle, channel } = await started();
      handle.mockRejectedValue(new DependencyUnavailableError('postgres'));
      await runner.handleDelivery(channel, consumeMessage(videoUploadedFixture));

      await runner.stop(10);
      await jest.advanceTimersByTimeAsync(500);

      expect(channel.consume).toHaveBeenCalledTimes(1);
    });

    it('isDependencyOutage: erro de dependência ou de conexão, nada mais', () => {
      expect(isDependencyOutage(new DependencyUnavailableError('smtp'))).toBe(true);
      expect(isDependencyOutage(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
        true,
      );
      expect(isDependencyOutage(new RetryableError('x'))).toBe(false);
      expect(isDependencyOutage(ProcessingErrors.NO_FRAMES())).toBe(false);
    });
  });

  describe('canal fechado durante o processamento (abort)', () => {
    async function started(definition: Partial<Definition> = {}) {
      const ctx = setup(definition);
      ctx.runner.start();
      await ctx.manager.wrappers[0].connect(ctx.channel);
      return ctx;
    }

    it('o handler recebe o sinal do canal; terminou depois do fechamento → sem ack', async () => {
      const { channel, handle, metrics } = await started();
      let signal: AbortSignal | undefined;
      let release: () => void = () => undefined;
      handle.mockImplementation((_event, context) => {
        signal = context.signal;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });

      channel.onMessage?.(consumeMessage(videoUploadedFixture));
      await Promise.resolve();
      channel.emit('close');
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toMatchObject({ name: 'ChannelClosedError' });

      release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(channel.ack).not.toHaveBeenCalled();
      expect(await metrics.consumedCount(QUEUE, 'aborted')).toBe(1);
    });

    it('falha depois do fechamento não publica cópia de retry nem dá nack', async () => {
      const { runner, channel, handle, publisher } = await started();
      handle.mockImplementation(() => {
        channel.emit('close');
        return Promise.reject(new RetryableError('ffmpeg morto pelo abort'));
      });

      channel.onMessage?.(consumeMessage(videoUploadedFixture));
      await new Promise((resolve) => setImmediate(resolve));

      expect(publisher.publish).not.toHaveBeenCalled();
      expect(channel.nack).not.toHaveBeenCalled();
      expect(channel.reject).not.toHaveBeenCalled();
      expect(runner.inFlightCount).toBe(0);
    });

    it('falha permanente depois do fechamento: nada de ack (o onPermanentFailure não confirma)', async () => {
      const onPermanentFailure = jest.fn(() => Promise.resolve());
      const { channel, handle } = await started({ onPermanentFailure });
      handle.mockImplementation(() => {
        channel.emit('close');
        return Promise.reject(ProcessingErrors.INVALID_VIDEO());
      });

      channel.onMessage?.(consumeMessage(videoUploadedFixture));
      await new Promise((resolve) => setImmediate(resolve));

      expect(onPermanentFailure).not.toHaveBeenCalled();
      expect(channel.ack).not.toHaveBeenCalled();
    });

    it('canal fecha enquanto o onPermanentFailure roda: não confirma', async () => {
      const { channel, handle } = await started({
        onPermanentFailure: () => {
          channel.emit('close');
          return Promise.resolve();
        },
      });
      handle.mockRejectedValue(ProcessingErrors.INVALID_VIDEO());

      channel.onMessage?.(consumeMessage(videoUploadedFixture));
      await new Promise((resolve) => setImmediate(resolve));

      expect(channel.ack).not.toHaveBeenCalled();
    });

    it('onPermanentFailure que falha depois do fechamento não vai para o retry', async () => {
      const { channel, handle, publisher } = await started({
        onPermanentFailure: () => {
          channel.emit('close');
          return Promise.reject(new Error('broker fora'));
        },
      });
      handle.mockRejectedValue(ProcessingErrors.INVALID_VIDEO());

      channel.onMessage?.(consumeMessage(videoUploadedFixture));
      await new Promise((resolve) => setImmediate(resolve));

      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('entrega que chega com o sinal já abortado nem chama o handler', async () => {
      const { runner, channel, handle } = setup();
      const controller = new AbortController();
      controller.abort();

      await expect(
        runner.handleDelivery(channel, consumeMessage(videoUploadedFixture), controller.signal),
      ).resolves.toBe('aborted');
      expect(handle).not.toHaveBeenCalled();
    });

    it('reentrega da MESMA mensagem espera a entrega anterior terminar (sem jobs paralelos)', async () => {
      const { channel, handle, logger } = await started();
      const order: string[] = [];
      let releaseFirst: () => void = () => undefined;
      handle
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              order.push('primeira:inicio');
              releaseFirst = () => {
                order.push('primeira:fim');
                resolve();
              };
            }),
        )
        .mockImplementationOnce(() => {
          order.push('segunda');
          return Promise.resolve();
        });

      channel.onMessage?.(consumeMessage(videoUploadedFixture));
      await Promise.resolve();
      channel.onMessage?.(consumeMessage(videoUploadedFixture, { redelivered: true }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual(['primeira:inicio']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: videoUploadedFixture.id }),
      );

      releaseFirst();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual(['primeira:inicio', 'primeira:fim', 'segunda']);
    });

    it('mensagens diferentes (ou sem messageId) não esperam umas pelas outras', async () => {
      const { channel, handle } = await started({ prefetch: 2 });
      let pending = 0;
      handle.mockImplementation(() => {
        pending += 1;
        return new Promise<void>(() => undefined);
      });

      channel.onMessage?.(consumeMessage(videoUploadedFixture));
      channel.onMessage?.(
        consumeMessage(videoUploadedFixture, { properties: { messageId: undefined } }),
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(pending).toBe(2);
    });
  });

  describe('re-assinatura e saúde', () => {
    it('re-assinatura com falha tenta de novo com backoff; canal trocado encerra as tentativas', async () => {
      jest.useFakeTimers();
      const ensureTopology = jest
        .fn<Promise<void>, []>()
        .mockRejectedValueOnce(new Error('sem conexão'))
        .mockResolvedValue(undefined);
      const ctx = setup({}, { ensureTopology });
      ctx.runner.start();
      await ctx.manager.wrappers[0].connect(ctx.channel);

      ctx.channel.onMessage?.(null);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.stringContaining('re-assinar'), attempt: 1 }),
      );
      await jest.advanceTimersByTimeAsync(2_000);
      expect(ctx.runner.isConsuming).toBe(true);

      // Novo cancelamento, mas a reconexão troca o canal antes do timer: nada a fazer.
      ctx.channel.onMessage?.(null);
      const fresh = new FakeChannel();
      ctx.channel.emit('close');
      await ctx.manager.wrappers[0].connect(fresh);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(ctx.channel.consume).toHaveBeenCalledTimes(2);
      expect(fresh.consume).toHaveBeenCalledTimes(1);
    });

    it('cancelamento pelo broker durante o stop não re-assina', async () => {
      jest.useFakeTimers();
      const ctx = setup();
      ctx.runner.start();
      await ctx.manager.wrappers[0].connect(ctx.channel);
      await ctx.runner.stop(10);

      ctx.channel.onMessage?.(null);
      await jest.advanceTimersByTimeAsync(5_000);

      expect(ctx.channel.consume).toHaveBeenCalledTimes(1);
    });

    it('isHealthy: falso só com o broker conectado e sem consumer além do limite', async () => {
      let now = 0;
      const ctx = setup({}, { now: () => now, timings: { unhealthyAfterMs: 1_000 } });
      expect(ctx.runner.isHealthy).toBe(true); // não iniciado

      ctx.runner.start();
      ctx.manager.connected = true;
      now = 999;
      expect(ctx.runner.isHealthy).toBe(true); // ainda dentro do limite
      now = 1_000;
      expect(ctx.runner.isHealthy).toBe(false);

      ctx.manager.connected = false;
      expect(ctx.runner.isHealthy).toBe(true); // broker fora não é culpa do processo

      ctx.manager.connected = true;
      await ctx.manager.wrappers[0].connect(ctx.channel);
      expect(ctx.runner.isHealthy).toBe(true); // consumindo

      await ctx.runner.stop(10);
      expect(ctx.runner.isHealthy).toBe(true); // parando
    });
  });
});
