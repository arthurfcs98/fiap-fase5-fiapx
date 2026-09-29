import { videoUploadedFixture } from '@fiapx/contracts/fixtures';
import type { Channel } from 'amqplib';
import { FakeChannel, fakeConnectFn, silentLogger } from '../../test/fakes/fake-amqp';
import { AmqpConnection } from '../connection/amqp-connection';
import { InvalidEventError, PublishError, UnroutableMessageError } from '../messaging.errors';
import { MessagePublisher } from './message-publisher';

function setup(options: ConstructorParameters<typeof MessagePublisher>[1] = {}) {
  const { manager, connectFn } = fakeConnectFn();
  const connection = new AmqpConnection(
    { url: 'amqp://x', connectionName: 'video-api', logger: silentLogger() },
    connectFn,
  );
  const logger = silentLogger();
  const publisher = new MessagePublisher(connection, { logger, ...options });
  const wrapper = manager.wrappers[0];
  return { publisher, wrapper, logger };
}

function returnMessage(channel: FakeChannel, messageId: unknown): void {
  channel.emit('return', {
    content: Buffer.from('{}'),
    fields: { exchange: 'fiapx.events', routingKey: 'x' },
    properties: { messageId },
  });
}

describe('MessagePublisher', () => {
  it('usa um ConfirmChannel dedicado com timeout padrão de 5 s', () => {
    const { wrapper } = setup();
    expect(wrapper.options).toMatchObject({
      name: 'publisher',
      confirm: true,
      publishTimeout: 5_000,
    });
  });

  it('o setup espera o beforePublish (ex.: topologia) a cada conexão', async () => {
    const beforePublish = jest.fn(() => Promise.resolve());
    const { wrapper } = setup({ beforePublish });

    await wrapper.connect();

    expect(beforePublish).toHaveBeenCalledTimes(1);
  });

  describe('publishEvent', () => {
    it('valida e publica no fiapx.events com as propriedades do contrato', async () => {
      const { publisher, wrapper } = setup({ appId: 'video-api', confirmTimeoutMs: 2_000 });

      await publisher.publishEvent(videoUploadedFixture, { headers: { 'x-extra': 'sim' } });

      expect(wrapper.publish).toHaveBeenCalledWith(
        'fiapx.events',
        'video.uploaded',
        Buffer.from(JSON.stringify(videoUploadedFixture)),
        {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          messageId: videoUploadedFixture.id,
          correlationId: videoUploadedFixture.correlationId,
          type: 'video.uploaded',
          appId: 'video-api',
          timestamp: Math.floor(Date.parse(videoUploadedFixture.occurredAt) / 1000),
          headers: { 'x-extra': 'sim', 'x-correlation-id': videoUploadedFixture.correlationId },
          timeout: 2_000,
        },
      );
    });

    it('aceita exchange, routing key e timeout explícitos', async () => {
      const { publisher, wrapper } = setup();

      await publisher.publishEvent(videoUploadedFixture, {
        exchange: 'outra',
        routingKey: 'rk',
        timeoutMs: 100,
      });

      expect(wrapper.publish).toHaveBeenCalledWith(
        'outra',
        'rk',
        expect.any(Buffer),
        expect.objectContaining({ timeout: 100 }),
      );
    });

    it('descarta campos fora do schema antes de publicar', async () => {
      const { publisher, wrapper } = setup();

      await publisher.publishEvent({ ...videoUploadedFixture, extra: 'x' } as never);

      const body = wrapper.publish.mock.calls[0]?.[2] as Buffer;
      expect(JSON.parse(body.toString())).toEqual(videoUploadedFixture);
    });

    it('rejeita type fora do contrato sem publicar', async () => {
      const { publisher, wrapper } = setup();

      await expect(
        publisher.publishEvent({ ...videoUploadedFixture, type: 'video.unknown' }),
      ).rejects.toThrow(InvalidEventError);
      expect(wrapper.publish).not.toHaveBeenCalled();
    });

    it('rejeita payload inválido sem publicar', async () => {
      const { publisher, wrapper } = setup();
      const bad = {
        ...videoUploadedFixture,
        payload: { ...videoUploadedFixture.payload, sizeBytes: 0 },
      };

      await expect(publisher.publishEvent(bad)).rejects.toMatchObject({
        name: 'InvalidEventError',
        eventType: 'video.uploaded',
        reason: expect.stringContaining('payload.sizeBytes'),
      });
      expect(wrapper.publish).not.toHaveBeenCalled();
    });
  });

  describe('publish', () => {
    const message = {
      exchange: '',
      routingKey: 'worker.video-uploaded.retry.1',
      content: Buffer.from('{}'),
      messageId: 'm-1',
      correlationId: 'cid',
      type: 'video.uploaded',
    };

    it('usa agora como timestamp e headers vazios por padrão', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_760_000_000_999);
      const { publisher, wrapper } = setup();

      await publisher.publish(message);

      expect(wrapper.publish.mock.calls[0]?.[3]).toMatchObject({
        timestamp: 1_760_000_000,
        headers: {},
        timeout: 5_000,
      });
    });

    it('converte falha do broker/timeout em PublishError com a causa', async () => {
      const { publisher, wrapper } = setup();
      const cause = new Error('timeout');
      wrapper.publish.mockRejectedValueOnce(cause);

      const error = await publisher.publish(message).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PublishError);
      expect(error).toMatchObject({
        exchange: '',
        routingKey: 'worker.video-uploaded.retry.1',
        cause,
      });
    });

    it('mensagem devolvida (basic.return) vira UnroutableMessageError', async () => {
      const { publisher, wrapper, logger } = setup();
      const channel = await wrapper.connect();
      wrapper.publish.mockImplementation(() => {
        returnMessage(channel, 'm-1');
        return Promise.resolve(true);
      });

      await expect(publisher.publish(message)).rejects.toThrow(UnroutableMessageError);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm-1' }));

      wrapper.publish.mockResolvedValue(true);
      await expect(publisher.publish(message)).resolves.toBeUndefined();
    });

    it('conta devoluções repetidas do mesmo messageId', async () => {
      const { publisher, wrapper } = setup();
      const channel = await wrapper.connect();
      returnMessage(channel, 'm-1');
      returnMessage(channel, 'm-1');

      await expect(publisher.publish(message)).rejects.toThrow(UnroutableMessageError);
      await expect(publisher.publish(message)).rejects.toThrow(UnroutableMessageError);
      await expect(publisher.publish(message)).resolves.toBeUndefined();
    });

    it('limpa a devolução pendente quando a publicação falha', async () => {
      const { publisher, wrapper } = setup();
      const channel = await wrapper.connect();
      wrapper.publish.mockImplementationOnce(() => {
        returnMessage(channel, 'm-1');
        return Promise.reject(new Error('nack'));
      });

      await expect(publisher.publish(message)).rejects.toThrow(PublishError);
      await expect(publisher.publish(message)).resolves.toBeUndefined();
    });

    it('devolução sem messageId só é logada', async () => {
      const { publisher, wrapper, logger } = setup();
      const channel = await wrapper.connect(new FakeChannel());
      returnMessage(channel, undefined);

      await expect(publisher.publish(message)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  it('close fecha o canal', async () => {
    const { publisher, wrapper } = setup();
    await publisher.close();
    expect(wrapper.close).toHaveBeenCalled();
  });

  it('usa o logger padrão quando nenhum é informado', async () => {
    const { manager, connectFn } = fakeConnectFn();
    const connection = new AmqpConnection(
      { url: 'amqp://x', connectionName: 'x', logger: silentLogger() },
      connectFn,
    );
    const publisher = new MessagePublisher(connection);
    const wrapper = manager.wrappers[0];
    const setupFn = wrapper.options.setup as (channel: Channel) => Promise<void>;
    await setupFn(new FakeChannel().asChannel());
    expect(publisher).toBeInstanceOf(MessagePublisher);
  });
});
