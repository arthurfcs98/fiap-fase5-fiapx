import { videoUploadedEvent } from '@fiapx/contracts';
import { HealthRegistry } from '@fiapx/observability';
import { Logger } from '@nestjs/common';
import { Registry } from '@prometheus-io/client';
import type { FakeChannelWrapper } from '../../test/fakes/fake-amqp';
import { FakeChannel, fakeConnectFn, silentLogger } from '../../test/fakes/fake-amqp';
import { AmqpConnection } from '../connection/amqp-connection';
import { MessagingMetrics } from '../messaging.metrics';
import { MessagePublisher } from '../publisher/message-publisher';
import { TopologyInitializer } from '../topology-setup';
import { CONSUMERS_HEALTH_CHECK, MessageConsumers } from './message-consumers.service';

function setup(health?: HealthRegistry) {
  const { manager, connectFn } = fakeConnectFn();
  const connection = new AmqpConnection(
    { url: 'amqp://x', connectionName: 'svc', logger: silentLogger() },
    connectFn,
  );
  const publisher = new MessagePublisher(connection, { logger: silentLogger() });
  const topology = new TopologyInitializer(connection, undefined, silentLogger());
  const whenReady = jest.spyOn(topology, 'whenReady');
  const redeclare = jest.spyOn(topology, 'redeclare');
  const consumers = new MessageConsumers(
    connection,
    publisher,
    new MessagingMetrics(new Registry()),
    topology,
    { url: 'amqp://x', connectionName: 'svc', shutdownTimeoutMs: 50 },
    health,
  );
  return { manager, consumers, whenReady, redeclare };
}

const definition = {
  queue: 'worker.video-uploaded',
  schema: videoUploadedEvent,
  handle: () => Promise.resolve(),
};

describe('MessageConsumers', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterAll(() => {
    Logger.overrideLogger(new Logger());
  });

  it('cria e inicia o runner, esperando a topologia antes de consumir', async () => {
    const { manager, consumers, whenReady } = setup();

    const runner = consumers.start(definition);
    const wrapper = manager.wrappers.find(
      (w) => w.options.name === 'consumer:worker.video-uploaded',
    );
    await (wrapper as FakeChannelWrapper).connect(new FakeChannel());

    expect(whenReady).toHaveBeenCalled();
    expect(runner.isConsuming).toBe(true);
    expect(consumers.all).toEqual([runner]);
  });

  it('registra a saúde dos consumidores no HEALTH_REGISTRY (falha se algum runner não está saudável)', () => {
    const health = new HealthRegistry();
    const { consumers } = setup(health);
    const runner = consumers.start(definition);
    expect(health.failing()).toEqual([]);

    jest.spyOn(runner, 'isHealthy', 'get').mockReturnValue(false);
    expect(health.failing()).toEqual([CONSUMERS_HEALTH_CHECK]);
  });

  it('re-assinatura de consumer cancelado pelo broker declara a topologia de novo', async () => {
    jest.useFakeTimers();
    try {
      const { manager, consumers, redeclare } = setup();
      const runner = consumers.start(definition);
      const channel = new FakeChannel();
      const wrapper = manager.wrappers.find(
        (w) => w.options.name === 'consumer:worker.video-uploaded',
      ) as FakeChannelWrapper;
      await wrapper.connect(channel);

      channel.onMessage?.(null);
      await jest.advanceTimersByTimeAsync(1_000);

      expect(redeclare).toHaveBeenCalled();
      expect(runner.isConsuming).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('recusa dois consumidores na mesma fila', () => {
    const { consumers } = setup();
    consumers.start(definition);
    expect(() => consumers.start(definition)).toThrow('Já existe');
  });

  it('para todos os consumidores no onModuleDestroy (antes do banco/conexão fecharem)', async () => {
    const { consumers } = setup();
    const runner = consumers.start(definition);
    const other = consumers.start({ ...definition, queue: 'notification.events' });
    const stops = [jest.spyOn(runner, 'stop'), jest.spyOn(other, 'stop')];

    await consumers.onModuleDestroy();

    stops.forEach((stop) => expect(stop).toHaveBeenCalled());
  });
});
