import type { ChannelModel } from 'amqplib';
import { FakeChannel, FakeConnection, fakeConnectFn, silentLogger } from '../test/fakes/fake-amqp';
import { AmqpConnection } from './connection/amqp-connection';
import { buildTopology } from './topology';
import { assertTopology, setupTopology, TopologyInitializer } from './topology-setup';

const topology = buildTopology();

describe('assertTopology', () => {
  it('declara exchanges, filas (duráveis, com argumentos) e bindings, nessa ordem', async () => {
    const channel = new FakeChannel();
    const order: string[] = [];
    channel.assertExchange.mockImplementation(() => {
      order.push('exchange');
      return Promise.resolve({});
    });
    channel.assertQueue.mockImplementation(() => {
      order.push('queue');
      return Promise.resolve({});
    });
    channel.bindQueue.mockImplementation(() => {
      order.push('bind');
      return Promise.resolve({});
    });

    await assertTopology(channel);

    expect(channel.assertExchange).toHaveBeenCalledWith('fiapx.events', 'topic', { durable: true });
    expect(channel.assertExchange).toHaveBeenCalledWith('fiapx.dlx', 'direct', { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledTimes(topology.queues.length);
    expect(channel.assertQueue).toHaveBeenCalledWith('worker.video-uploaded.retry.1', {
      durable: true,
      arguments: expect.objectContaining({ 'x-message-ttl': 5_000 }),
    });
    expect(channel.bindQueue).toHaveBeenCalledWith(
      'api.video-processing',
      'fiapx.events',
      'video.processing.*',
    );
    expect(order.indexOf('bind')).toBeGreaterThan(order.lastIndexOf('queue'));
    expect(order.lastIndexOf('exchange')).toBeLessThan(order.indexOf('queue'));
  });
});

describe('setupTopology (one-shot rabbitmq-init)', () => {
  function fakeAmqplib(connection = new FakeConnection()) {
    const connect = jest.fn(
      (_url: string, _options: { clientProperties: Record<string, string> }) =>
        Promise.resolve(connection as unknown as ChannelModel),
    );
    return { connection, connect };
  }

  it('declara tudo num canal e fecha canal e conexão', async () => {
    const { connection, connect } = fakeAmqplib();

    const result = await setupTopology({ url: 'amqp://x', connect });

    expect(result).toEqual(topology);
    expect(connect).toHaveBeenCalledWith('amqp://x', {
      clientProperties: { connection_name: 'rabbitmq-init' },
    });
    const channel = connection.channels[0];
    expect(channel?.assertQueue).toHaveBeenCalledTimes(topology.queues.length);
    expect(channel?.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
    channel?.emit('error', new Error('ignorado'));
    connection.emit('error', new Error('ignorado'));
  });

  it('fecha a conexão e propaga o erro quando a declaração falha', async () => {
    const connection = new FakeConnection();
    connection.createChannel.mockImplementation(() => {
      const channel = new FakeChannel();
      channel.assertQueue.mockRejectedValue(new Error('PRECONDITION_FAILED'));
      return Promise.resolve(channel);
    });
    const { connect } = fakeAmqplib(connection);
    const custom = buildTopology({ retryDelaysMs: [1, 2, 3] });

    await expect(
      setupTopology({ url: 'amqp://x', connect, topology: custom, connectionName: 'init' }),
    ).rejects.toThrow('PRECONDITION_FAILED');
    expect(connection.close).toHaveBeenCalled();
    expect(connect.mock.calls[0]?.[1]).toEqual({ clientProperties: { connection_name: 'init' } });
  });
});

describe('TopologyInitializer', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function setup(withTopology = true) {
    const { manager, connectFn } = fakeConnectFn();
    const logger = silentLogger();
    const connection = new AmqpConnection(
      { url: 'amqp://x', connectionName: 't', logger: silentLogger() },
      connectFn,
    );
    const initializer = new TopologyInitializer(
      connection,
      withTopology ? topology : undefined,
      logger,
      1_000,
    );
    return { manager, logger, initializer };
  }

  it('sem topologia libera a espera na hora (confia no rabbitmq-init)', async () => {
    const { initializer, manager } = setup(false);

    initializer.start();
    manager.simulateConnect();

    await expect(initializer.whenReady()).resolves.toBeUndefined();
    expect(initializer.isReady).toBe(true);
    expect(manager.connection?.createChannel).not.toHaveBeenCalled();
  });

  it('usa o logger padrão quando nenhum é informado', () => {
    const { connectFn } = fakeConnectFn();
    const connection = new AmqpConnection(
      { url: 'amqp://x', connectionName: 't', logger: silentLogger() },
      connectFn,
    );
    expect(new TopologyInitializer(connection, undefined).isReady).toBe(true);
  });

  it('declara a cada conexão e libera a espera após a primeira', async () => {
    const { initializer, manager, logger } = setup();
    initializer.start();
    initializer.start(); // idempotente
    expect(initializer.isReady).toBe(false);

    const first = manager.simulateConnect();
    await initializer.whenReady();
    manager.simulateConnect(first);
    await new Promise((resolve) => setImmediate(resolve));

    expect(initializer.isReady).toBe(true);
    expect(first.createChannel).toHaveBeenCalledTimes(2);
    expect(first.channels[0]?.close).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(1);
    first.channels[0]?.emit('error', new Error('ignorado'));
  });

  it('em falha, loga e tenta de novo na mesma conexão após o intervalo', async () => {
    jest.useFakeTimers();
    const { initializer, manager, logger } = setup();
    const connection = new FakeConnection();
    connection.createChannel.mockRejectedValueOnce(new Error('canal recusado'));
    initializer.start();

    manager.simulateConnect(connection);
    await jest.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Error: canal recusado' }),
    );
    expect(initializer.isReady).toBe(false);

    await jest.advanceTimersByTimeAsync(1_000);

    expect(connection.createChannel).toHaveBeenCalledTimes(2);
    expect(initializer.isReady).toBe(true);
  });

  it('não tenta de novo depois do stop nem se a conexão mudou', async () => {
    jest.useFakeTimers();
    const { initializer, manager } = setup();
    const failing = new FakeConnection();
    failing.createChannel.mockRejectedValue(new Error('x'));
    initializer.start();

    manager.simulateConnect(failing);
    await jest.advanceTimersByTimeAsync(0);
    manager.connection = new FakeConnection(); // reconectou em outra conexão
    await jest.advanceTimersByTimeAsync(1_000);
    expect(failing.createChannel).toHaveBeenCalledTimes(1);

    manager.connection = failing;
    manager.simulateConnect(failing);
    await jest.advanceTimersByTimeAsync(0);
    initializer.stop();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(failing.createChannel).toHaveBeenCalledTimes(2);
  });

  it('não agenda retry se já foi parado quando a falha acontece', async () => {
    jest.useFakeTimers();
    const { initializer, manager } = setup();
    let rejectChannel: (error: Error) => void = () => undefined;
    const connection = new FakeConnection();
    connection.createChannel.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectChannel = reject;
        }),
    );
    initializer.start();
    manager.simulateConnect(connection);

    initializer.stop();
    rejectChannel(new Error('tarde demais'));
    await jest.advanceTimersByTimeAsync(5_000);

    expect(connection.createChannel).toHaveBeenCalledTimes(1);
  });
});
