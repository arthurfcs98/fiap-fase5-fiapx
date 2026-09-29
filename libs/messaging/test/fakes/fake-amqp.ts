import { EventEmitter } from 'node:events';
import type {
  AmqpConnectionManager,
  AmqpConnectionManagerOptions,
  CreateChannelOpts,
} from 'amqp-connection-manager';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { AmqpConnectFn } from '../../src/connection/amqp-connection';
import type { MessagingLogger } from '../../src/messaging.logger';

/**
 * Dublês do amqplib / amqp-connection-manager para os testes UNITÁRIOS da lib (os testes de
 * integração usam RabbitMQ real). Fora de `src/`: não entram na cobertura nem no bundle.
 */
export class FakeChannel extends EventEmitter {
  onMessage?: (message: ConsumeMessage | null) => void;
  consumedQueue?: string;
  prefetch = jest.fn((_count: number) => Promise.resolve());
  consume = jest.fn(
    (queue: string, onMessage: (message: ConsumeMessage | null) => void, _options?: unknown) => {
      this.consumedQueue = queue;
      this.onMessage = onMessage;
      return Promise.resolve({ consumerTag: `ctag-${queue}` });
    },
  );
  cancel = jest.fn((_tag: string) => Promise.resolve({}));
  ack = jest.fn();
  nack = jest.fn();
  reject = jest.fn();
  assertExchange = jest.fn(() => Promise.resolve({}));
  assertQueue = jest.fn(() => Promise.resolve({}));
  bindQueue = jest.fn(() => Promise.resolve({}));
  close = jest.fn(() => {
    this.emit('close');
    return Promise.resolve();
  });

  asChannel(): Channel {
    return this as unknown as Channel;
  }
}

export class FakeChannelWrapper extends EventEmitter {
  publish = jest.fn((..._args: unknown[]) => Promise.resolve(true));
  close = jest.fn(() => {
    this.emit('close');
    return Promise.resolve();
  });

  constructor(readonly options: CreateChannelOpts) {
    super();
  }

  /** Simula a (re)conexão: roda o `setup` com um canal novo. */
  async connect(channel: FakeChannel = new FakeChannel()): Promise<FakeChannel> {
    const setup = this.options.setup as ((channel: Channel) => Promise<void>) | undefined;
    await setup?.(channel.asChannel());
    return channel;
  }
}

export class FakeConnection extends EventEmitter {
  readonly channels: FakeChannel[] = [];
  createChannel = jest.fn(() => {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return Promise.resolve(channel);
  });
  close = jest.fn(() => Promise.resolve());
}

export class FakeConnectionManager extends EventEmitter {
  connected = false;
  connection?: FakeConnection;
  readonly wrappers: FakeChannelWrapper[] = [];
  connect = jest.fn((_options?: { timeout?: number }) => Promise.resolve());
  reconnect = jest.fn();
  close = jest.fn(() => Promise.resolve());

  isConnected(): boolean {
    return this.connected;
  }

  createChannel(options: CreateChannelOpts = {}): FakeChannelWrapper {
    const wrapper = new FakeChannelWrapper(options);
    this.wrappers.push(wrapper);
    return wrapper;
  }

  simulateConnect(connection: FakeConnection = new FakeConnection()): FakeConnection {
    this.connected = true;
    this.connection = connection;
    this.emit('connect', { connection, url: 'amqp://fake' });
    return connection;
  }

  simulateDisconnect(): void {
    this.connected = false;
    this.connection = undefined;
    this.emit('disconnect', { err: new Error('socket closed') });
  }
}

export function fakeConnectFn(manager = new FakeConnectionManager()): {
  manager: FakeConnectionManager;
  connectFn: jest.MockedFunction<AmqpConnectFn>;
} {
  const connectFn = jest.fn(
    (_urls: string[], _options: AmqpConnectionManagerOptions) =>
      manager as unknown as AmqpConnectionManager,
  );
  return { manager, connectFn };
}

export function silentLogger(): jest.Mocked<MessagingLogger> {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** Monta uma entrega amqplib (corpo = objeto serializado ou Buffer cru). */
export function consumeMessage(
  body: unknown,
  overrides: {
    headers?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    redelivered?: boolean;
  } = {},
): ConsumeMessage {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const envelope = (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  return {
    content,
    fields: {
      deliveryTag: 1,
      redelivered: overrides.redelivered ?? false,
      exchange: 'fiapx.events',
      routingKey: typeof envelope['type'] === 'string' ? envelope['type'] : 'x',
      consumerTag: 'ctag',
    },
    properties: {
      contentType: 'application/json',
      contentEncoding: undefined,
      headers: overrides.headers,
      deliveryMode: 2,
      priority: undefined,
      correlationId: envelope['correlationId'],
      replyTo: undefined,
      expiration: undefined,
      messageId: envelope['id'],
      timestamp: 1_760_097_600,
      type: envelope['type'],
      userId: undefined,
      appId: 'video-api',
      clusterId: undefined,
      ...overrides.properties,
    },
  };
}
