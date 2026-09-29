import { fakeConnectFn, silentLogger } from '../../test/fakes/fake-amqp';
import { AmqpConnection } from '../connection/amqp-connection';
import { MessagePublisher } from '../publisher/message-publisher';
import { TopologyInitializer } from '../topology-setup';
import { MessagingLifecycle } from './messaging-lifecycle.service';

function setup() {
  const { manager, connectFn } = fakeConnectFn();
  const connection = new AmqpConnection(
    { url: 'amqp://x', connectionName: 'svc', logger: silentLogger() },
    connectFn,
  );
  const publisher = new MessagePublisher(connection, { logger: silentLogger() });
  const topology = new TopologyInitializer(connection, undefined, silentLogger());
  return { manager, connection, publisher, topology };
}

describe('MessagingLifecycle', () => {
  it('inicia a declaração da topologia no init', () => {
    const { connection, publisher, topology } = setup();
    const start = jest.spyOn(topology, 'start');

    new MessagingLifecycle(connection, publisher, topology).onModuleInit();

    expect(start).toHaveBeenCalled();
  });

  it('no shutdown fecha publicador e conexão, mesmo se o publicador falhar', async () => {
    const { manager, connection, publisher, topology } = setup();
    jest.spyOn(publisher, 'close').mockRejectedValue(new Error('canal já fechado'));
    const stop = jest.spyOn(topology, 'stop');

    await new MessagingLifecycle(connection, publisher, topology).onApplicationShutdown();

    expect(stop).toHaveBeenCalled();
    expect(manager.close).toHaveBeenCalled();
  });
});
