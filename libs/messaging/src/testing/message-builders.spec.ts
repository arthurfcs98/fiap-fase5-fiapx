import { videoUploadedEvent } from '@fiapx/contracts';
import { videoUploadedFixture } from '@fiapx/contracts/fixtures';
import { Registry } from '@prometheus-io/client';
import { fakeConnectFn, silentLogger } from '../../test/fakes/fake-amqp';
import { AmqpConnection } from '../connection/amqp-connection';
import { ConsumerRunner } from '../consumer/consumer-runner';
import { MessagingMetrics } from '../messaging.metrics';
import { consumeMessageFor, messageContext, RecordingAckChannel } from './message-builders';
import { RecordingEventPublisher } from './recording-event-publisher';

describe('construtores de mensagem para testes', () => {
  it('messageContext parte do envelope e aceita overrides', () => {
    const { signal, ...context } = messageContext(videoUploadedFixture, { retryCount: 2 });
    expect(context).toEqual({
      queue: 'test.queue',
      messageId: videoUploadedFixture.id,
      correlationId: videoUploadedFixture.correlationId,
      retryCount: 2,
      deliveryCount: 0,
      redelivered: false,
      deathReason: undefined,
      headers: {},
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('consumeMessageFor + RecordingAckChannel exercitam o ConsumerRunner de ponta a ponta', async () => {
    const { connectFn } = fakeConnectFn();
    const connection = new AmqpConnection(
      { url: 'amqp://x', connectionName: 't', logger: silentLogger() },
      connectFn,
    );
    const publisher = new RecordingEventPublisher();
    const runner = new ConsumerRunner(
      {
        queue: 'worker.video-uploaded',
        schema: videoUploadedEvent,
        handle: () => Promise.reject(new Error('transitório')),
      },
      {
        connection,
        publisher,
        metrics: new MessagingMetrics(new Registry()),
        logger: silentLogger(),
      },
    );
    const channel = new RecordingAckChannel();

    const message = consumeMessageFor(videoUploadedFixture, {
      headers: { 'x-retry-count': 3 },
      redelivered: true,
    });
    expect(message.properties.headers).toMatchObject({
      'x-correlation-id': videoUploadedFixture.correlationId,
    });
    await expect(runner.handleDelivery(channel, message)).resolves.toBe('dead_letter');
    await expect(
      runner.handleDelivery(channel, consumeMessageFor(videoUploadedFixture)),
    ).resolves.toBe('retry');
    await expect(
      runner.handleDelivery(
        channel,
        consumeMessageFor(videoUploadedFixture, { rawContent: Buffer.from('x') }),
      ),
    ).resolves.toBe('invalid');

    expect(channel.deadLettered).toHaveLength(2);
    expect(channel.acks).toHaveLength(1);
    expect(publisher.rawMessages[0]?.routingKey).toBe('worker.video-uploaded.retry.1');
  });

  it('RecordingAckChannel separa requeue de dead-letter', () => {
    const channel = new RecordingAckChannel();
    const message = consumeMessageFor(videoUploadedFixture);

    channel.reject(message, true);
    channel.reject(message, false);
    channel.nack(message, false, true);

    expect(channel.requeued).toHaveLength(2);
    expect(channel.deadLettered).toHaveLength(1);
  });
});
