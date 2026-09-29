import { RetryableError } from '@fiapx/common';
import { notificationEvent } from '@fiapx/contracts';
import {
  userDeletedFixture,
  videoCompletedFixture,
  videoFailedFixture,
  videoUploadedFixture,
} from '@fiapx/contracts/fixtures';
import type { AmqpConnection, MessageConsumers, OutgoingMessage } from '@fiapx/messaging';
import { ConsumerRunner, MESSAGE_HEADERS, QUEUES } from '@fiapx/messaging';
import { consumeMessageFor, messageContext, RecordingAckChannel } from '@fiapx/messaging/testing';
import type { AnonymizeUserNotificationsUseCase } from '../../application/use-cases/anonymize-user-notifications.use-case';
import type { SendVideoNotificationUseCase } from '../../application/use-cases/send-video-notification.use-case';
import { NOTIFICATION_PREFETCH, NotificationEventsConsumer } from './notification-events.consumer';

function setup() {
  const send = { execute: jest.fn().mockResolvedValue('SENT') };
  const anonymize = { execute: jest.fn().mockResolvedValue(1) };
  const consumers = { start: jest.fn() };
  const consumer = new NotificationEventsConsumer(
    consumers as unknown as MessageConsumers,
    send as unknown as SendVideoNotificationUseCase,
    anonymize as unknown as AnonymizeUserNotificationsUseCase,
  );
  return { send, anonymize, consumers, consumer };
}

/** The real runner (ack/retry/DLX rules of `@fiapx/messaging`) around the consumer definition. */
function runnerFor(consumer: NotificationEventsConsumer) {
  const published: OutgoingMessage[] = [];
  const runner = new ConsumerRunner(consumer.definition(), {
    connection: {} as AmqpConnection,
    publisher: {
      publish: (message: OutgoingMessage) => {
        published.push(message);
        return Promise.resolve();
      },
    },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { runner, published, channel: new RecordingAckChannel() };
}

describe('NotificationEventsConsumer', () => {
  it('consumes notification.events with the contract schema and prefetch 5', () => {
    const { consumer, consumers } = setup();

    consumer.onApplicationBootstrap();

    const definition = consumers.start.mock.calls[0]?.[0] as ReturnType<
      NotificationEventsConsumer['definition']
    >;
    expect(definition).toMatchObject({ queue: 'notification.events', prefetch: 5 });
    expect(definition.schema).toBe(notificationEvent);
    expect(NOTIFICATION_PREFETCH).toBe(5);
  });

  it('video.failed → VIDEO_FAILED e-mail', async () => {
    const { consumer, send, anonymize } = setup();

    await consumer.handle(videoFailedFixture, messageContext(videoFailedFixture));

    expect(send.execute).toHaveBeenCalledWith({
      type: 'VIDEO_FAILED',
      payload: videoFailedFixture.payload,
      correlationId: videoFailedFixture.correlationId,
      finalAttempt: false,
    });
    expect(anonymize.execute).not.toHaveBeenCalled();
  });

  it('video.completed → VIDEO_COMPLETED e-mail', async () => {
    const { consumer, send } = setup();

    await consumer.handle(videoCompletedFixture, messageContext(videoCompletedFixture));

    expect(send.execute).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'VIDEO_COMPLETED', payload: videoCompletedFixture.payload }),
    );
  });

  it('user.deleted → anonymizes the user notifications (LGPD)', async () => {
    const { consumer, send, anonymize } = setup();

    await consumer.handle(userDeletedFixture, messageContext(userDeletedFixture));

    expect(anonymize.execute).toHaveBeenCalledWith(userDeletedFixture.payload.userId);
    expect(send.execute).not.toHaveBeenCalled();
  });

  it.each([
    [0, false],
    [2, false],
    [3, true],
  ])('retryCount %p → finalAttempt %p', async (retryCount, finalAttempt) => {
    const { consumer, send } = setup();

    await consumer.handle(videoFailedFixture, messageContext(videoFailedFixture, { retryCount }));

    expect(send.execute).toHaveBeenCalledWith(expect.objectContaining({ finalAttempt }));
  });

  describe('with the real ConsumerRunner (ack/retry rules)', () => {
    it('acks after the e-mail is handled', async () => {
      const { consumer } = setup();
      const { runner, channel } = runnerFor(consumer);

      await expect(
        runner.handleDelivery(channel, consumeMessageFor(videoFailedFixture)),
      ).resolves.toBe('success');
      expect(channel.acks).toHaveLength(1);
    });

    it('sends a transient failure to notification.events.retry.1 with a redacted x-last-error', async () => {
      const { consumer, send } = setup();
      send.execute.mockRejectedValue(
        Object.assign(new Error('connection lost while saving arthur@example.com'), {
          name: 'QueryFailedError',
        }),
      );
      const { runner, channel, published } = runnerFor(consumer);

      await expect(
        runner.handleDelivery(channel, consumeMessageFor(videoFailedFixture)),
      ).resolves.toBe('retry');

      expect(channel.acks).toHaveLength(1);
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        exchange: '',
        routingKey: `${QUEUES.notificationEvents}.retry.1`,
        messageId: videoFailedFixture.id,
      });
      const headers = published[0]?.headers ?? {};
      expect(headers[MESSAGE_HEADERS.retryCount]).toBe(1);
      expect(headers[MESSAGE_HEADERS.lastError]).toBe(
        'RetryableError: Falha transitória: QueryFailedError: connection lost while saving [email]',
      );
    });

    it('dead-letters after the last retry (the use case already marked it FAILED)', async () => {
      const { consumer, send } = setup();
      send.execute.mockRejectedValue(new RetryableError('Resend 503'));
      const { runner, channel, published } = runnerFor(consumer);

      const result = await runner.handleDelivery(
        channel,
        consumeMessageFor(videoFailedFixture, { headers: { [MESSAGE_HEADERS.retryCount]: 3 } }),
      );

      expect(result).toBe('dead_letter');
      expect(channel.deadLettered).toHaveLength(1);
      expect(published).toHaveLength(0);
      expect(send.execute).toHaveBeenCalledWith(expect.objectContaining({ finalAttempt: true }));
    });

    it('sends an event that does not belong to the queue to the DLX without calling a use case', async () => {
      const { consumer, send, anonymize } = setup();
      const { runner, channel } = runnerFor(consumer);

      await expect(
        runner.handleDelivery(channel, consumeMessageFor(videoUploadedFixture)),
      ).resolves.toBe('invalid');
      expect(channel.deadLettered).toHaveLength(1);
      expect(send.execute).not.toHaveBeenCalled();
      expect(anonymize.execute).not.toHaveBeenCalled();
    });
  });
});
