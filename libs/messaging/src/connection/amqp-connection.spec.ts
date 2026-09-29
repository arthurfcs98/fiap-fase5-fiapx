import type { Channel } from 'amqplib';
import {
  FakeChannel,
  FakeConnection,
  fakeConnectFn,
  silentLogger,
} from '../../test/fakes/fake-amqp';
import { AmqpConnection } from './amqp-connection';

function setup(overrides: Partial<ConstructorParameters<typeof AmqpConnection>[0]> = {}) {
  const { manager, connectFn } = fakeConnectFn();
  const logger = silentLogger();
  const connection = new AmqpConnection(
    { url: 'amqp://u:p@rabbit:5672', connectionName: 'video-worker', logger, ...overrides },
    connectFn,
  );
  return { manager, connectFn, logger, connection };
}

describe('AmqpConnection', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('conecta com heartbeat, reconexão e nome da conexão padrão', () => {
    const { connectFn, connection } = setup();

    expect(connectFn).toHaveBeenCalledWith(['amqp://u:p@rabbit:5672'], {
      heartbeatIntervalInSeconds: 15,
      reconnectTimeInSeconds: 5,
      connectionOptions: { clientProperties: { connection_name: 'video-worker' } },
    });
    expect(connection.connectionName).toBe('video-worker');
  });

  it('aceita heartbeat e intervalo de reconexão customizados', () => {
    const { connectFn } = setup({ heartbeatIntervalInSeconds: 30, reconnectTimeInSeconds: 2 });
    expect(connectFn.mock.calls[0]?.[1]).toMatchObject({
      heartbeatIntervalInSeconds: 30,
      reconnectTimeInSeconds: 2,
    });
  });

  it('usa o amqp-connection-manager real por padrão (sem bloquear o construtor)', async () => {
    const connection = new AmqpConnection({
      url: 'amqp://127.0.0.1:1',
      connectionName: 'default-connect',
      reconnectTimeInSeconds: 1,
      logger: silentLogger(),
    });
    expect(connection.isConnected()).toBe(false);
    await connection.close();
  });

  it('não trava o shutdown se o manager não conclui o close', async () => {
    jest.useFakeTimers();
    const { manager, connection, logger } = setup({ reconnectTimeInSeconds: 1 });
    manager.close.mockReturnValue(new Promise(() => undefined));

    const closing = connection.close();
    await jest.advanceTimersByTimeAsync(2_000);
    await closing;

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('abandonada'));
  });

  it('expõe estado e conexão atual do manager', () => {
    const { manager, connection } = setup();
    expect(connection.isConnected()).toBe(false);
    expect(connection.currentConnection).toBeUndefined();

    const raw = manager.simulateConnect();

    expect(connection.isConnected()).toBe(true);
    expect(connection.currentConnection).toBe(raw);
  });

  describe('onConnect', () => {
    it('chama o listener a cada conexão e permite remover', () => {
      const { manager, connection } = setup();
      const listener = jest.fn();

      const unsubscribe = connection.onConnect(listener);
      const first = manager.simulateConnect();
      unsubscribe();
      manager.simulateConnect();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(first);
    });

    it('chama na hora quando já está conectado', () => {
      const { manager, connection } = setup();
      const raw = manager.simulateConnect();
      const listener = jest.fn();

      connection.onConnect(listener);

      expect(listener).toHaveBeenCalledWith(raw);
    });
  });

  describe('waitForConnect', () => {
    it('resolve na hora se já conectado', async () => {
      const { manager, connection } = setup();
      manager.simulateConnect();

      await connection.waitForConnect();

      expect(manager.connect).not.toHaveBeenCalled();
    });

    it('espera o connect do manager com timeout', async () => {
      const { manager, connection } = setup();

      await connection.waitForConnect(1234);
      await connection.waitForConnect();

      expect(manager.connect).toHaveBeenNthCalledWith(1, { timeout: 1234 });
      expect(manager.connect).toHaveBeenNthCalledWith(2, { timeout: 30_000 });
    });
  });

  describe('createChannel', () => {
    it('repassa nome, confirm e timeout e roda o setup do chamador', async () => {
      const { manager, connection } = setup();
      const userSetup = jest.fn((_channel: Channel) => Promise.resolve());

      connection.createChannel({
        name: 'publisher',
        confirm: true,
        publishTimeoutMs: 5000,
        setup: userSetup,
      });
      const wrapper = manager.wrappers[0];
      const channel = await wrapper?.connect();

      expect(wrapper?.options).toMatchObject({
        name: 'publisher',
        confirm: true,
        publishTimeout: 5000,
      });
      expect(userSetup).toHaveBeenCalledWith(channel);
    });

    it('funciona sem setup do chamador e loga erros do canal', async () => {
      const { manager, connection, logger } = setup();
      connection.createChannel({ name: 'c', confirm: false });
      const channel = await manager.wrappers[0]?.connect();

      channel?.emit('error', new Error('406'));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'c', error: 'Error: 406' }),
      );
    });

    it('loga falha de setup emitida pelo wrapper', () => {
      const { manager, connection, logger } = setup();
      connection.createChannel({ name: 'c', confirm: false });

      manager.wrappers[0]?.emit('error', new Error('setup'), { name: 'c' });

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ channel: 'c' }));
    });

    it('força reconexão quando o broker fecha o canal com a conexão de pé', async () => {
      jest.useFakeTimers();
      const { manager, connection, logger } = setup({ channelRecoveryDelayMs: 100 });
      manager.simulateConnect();
      connection.createChannel({ name: 'publisher', confirm: true });
      const channel = await manager.wrappers[0]?.connect();

      channel.emit('close');
      jest.advanceTimersByTime(100);

      expect(manager.reconnect).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ channel: 'publisher' }));
    });

    it('limita as reconexões forçadas a uma por intervalo de reconexão', async () => {
      jest.useFakeTimers();
      const { manager, connection } = setup({
        channelRecoveryDelayMs: 100,
        reconnectTimeInSeconds: 1,
      });
      manager.simulateConnect();
      connection.createChannel({ name: 'a', confirm: false });
      connection.createChannel({ name: 'b', confirm: false });
      const a = await manager.wrappers[0]?.connect();
      const b = await manager.wrappers[1]?.connect();

      a.emit('close');
      b.emit('close');
      jest.advanceTimersByTime(100);
      expect(manager.reconnect).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1_000);
      expect(manager.reconnect).toHaveBeenCalledTimes(2);
    });

    interface RecoveryContext {
      wrapperClose: () => Promise<void>;
      disconnect: () => Promise<void>;
      newSetup: () => Promise<void>;
    }

    it.each([
      ['o wrapper foi fechado de propósito', (ctx: RecoveryContext) => ctx.wrapperClose()],
      ['a conexão caiu', (ctx: RecoveryContext) => ctx.disconnect()],
      ['um novo canal já foi criado', (ctx: RecoveryContext) => ctx.newSetup()],
    ])('não força reconexão quando %s', async (_caso, act) => {
      jest.useFakeTimers();
      const { manager, connection } = setup({ channelRecoveryDelayMs: 100 });
      manager.simulateConnect();
      connection.createChannel({ name: 'c', confirm: false });
      const wrapper = manager.wrappers[0];
      const channel = await wrapper?.connect();

      channel?.emit('close');
      await act({
        wrapperClose: () => {
          wrapper?.emit('close');
          return Promise.resolve();
        },
        disconnect: () => {
          manager.simulateDisconnect();
          return Promise.resolve();
        },
        newSetup: async () => {
          await wrapper?.connect(new FakeChannel());
        },
      });
      jest.advanceTimersByTime(100);

      expect(manager.reconnect).not.toHaveBeenCalled();
    });

    it('não agenda recuperação durante o close da conexão', async () => {
      jest.useFakeTimers();
      const { manager, connection } = setup({ channelRecoveryDelayMs: 100 });
      manager.simulateConnect();
      connection.createChannel({ name: 'c', confirm: false });
      const channel = await manager.wrappers[0]?.connect();

      const closing = connection.close();
      channel.emit('close');
      jest.advanceTimersByTime(1_000);
      await closing;

      expect(manager.reconnect).not.toHaveBeenCalled();
    });

    it('não reconecta se o close da conexão começou durante a espera', async () => {
      jest.useFakeTimers();
      const { manager, connection } = setup({ channelRecoveryDelayMs: 100 });
      manager.simulateConnect();
      connection.createChannel({ name: 'c', confirm: false });
      const channel = await manager.wrappers[0]?.connect();

      channel.emit('close');
      await connection.close();
      jest.advanceTimersByTime(100);

      expect(manager.reconnect).not.toHaveBeenCalled();
    });
  });

  it('close encerra o manager uma única vez', async () => {
    const { manager, connection, logger } = setup();

    await connection.close();
    await connection.close();

    expect(manager.close).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('encerrada'));
  });

  it('loga os eventos da conexão sem expor a URL', () => {
    const { manager, logger } = setup();

    manager.simulateConnect(new FakeConnection());
    manager.simulateDisconnect();
    manager.emit('connectFailed', { err: new Error('ECONNREFUSED'), url: 'amqp://u:p@x' });
    manager.emit('blocked', { reason: 'low on memory' });
    manager.emit('unblocked');

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('video-worker'));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Error: socket closed' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Error: ECONNREFUSED' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'low on memory' }));
    expect(logger.log).toHaveBeenCalledWith('RabbitMQ liberou as publicações');
    expect(JSON.stringify([logger.log.mock.calls, logger.warn.mock.calls])).not.toContain('u:p@');
  });

  it('não loga a queda da conexão durante o próprio close', async () => {
    const { manager, connection, logger } = setup();
    await connection.close();

    manager.simulateDisconnect();

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
