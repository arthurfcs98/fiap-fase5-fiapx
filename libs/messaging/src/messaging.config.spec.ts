import { z } from 'zod';
import { messagingConfigShape } from './messaging.config';

const schema = z.object(messagingConfigShape);

describe('messagingConfigShape', () => {
  it.each(['amqp://fiapx:s3nh4@rabbitmq:5672', 'amqps://u:p@broker.example:5671/vhost'])(
    'aceita %s',
    (url) => {
      expect(schema.parse({ RABBITMQ_URL: url }).RABBITMQ_URL).toBe(url);
    },
  );

  it.each(['http://rabbitmq:5672', 'rabbitmq:5672', 'amqp://', ''])('rejeita %p', (url) => {
    expect(schema.safeParse({ RABBITMQ_URL: url }).success).toBe(false);
  });
});
