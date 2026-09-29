import { ProcessingErrors, RetryableError } from '@fiapx/common';
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
import { ConsumerRunner } from './consumer-runner';

type Definition = ConsumerDefinition<typeof videoUploadedEvent>;
const QUEUE = 'worker.video-uploaded';

function setup(
  definition: Partial<Definition> = {},
  deps: { beforeConsume?: () => Promise<void>; shutdownTimeoutMs?: number } = {},
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

    it('consumer cancelado pelo broker (mensagem null) deixa de estar ativo', async () => {
      const { runner, channel, logger } = await started();

      channel.onMessage?.(null);

      expect(runner.isConsuming).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ queue: QUEUE }));
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
});
