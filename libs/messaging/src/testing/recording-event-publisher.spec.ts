import { videoFailedFixture, videoUploadedFixture } from '@fiapx/contracts/fixtures';
import { InvalidEventError } from '../messaging.errors';
import { RecordingEventPublisher } from './recording-event-publisher';

describe('RecordingEventPublisher', () => {
  it('valida e registra os eventos publicados', async () => {
    const publisher = new RecordingEventPublisher();

    await publisher.publishEvent(videoUploadedFixture);
    await publisher.publishEvent(videoFailedFixture, { headers: { a: 1 } });

    expect(publisher.events).toEqual([videoUploadedFixture, videoFailedFixture]);
    expect(publisher.ofType('video.failed')).toEqual([videoFailedFixture]);
    expect(publisher.published[1]?.options).toEqual({ headers: { a: 1 } });
  });

  it('rejeita eventos fora do contrato como o publicador real', async () => {
    const publisher = new RecordingEventPublisher();
    await expect(
      publisher.publishEvent({ ...videoUploadedFixture, type: 'x.y' }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    await expect(
      publisher.publishEvent({ ...videoUploadedFixture, payload: {} }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    expect(publisher.events).toEqual([]);
  });

  it('simula falhas nas próximas publicações e registra mensagens cruas', async () => {
    const publisher = new RecordingEventPublisher().failNextWith(new Error('a'), new Error('b'));
    const raw = {
      exchange: '',
      routingKey: 'q.retry.1',
      content: Buffer.from('{}'),
      messageId: 'm',
      correlationId: 'c',
      type: 't',
    };

    await expect(publisher.publishEvent(videoUploadedFixture)).rejects.toThrow('a');
    await expect(publisher.publish(raw)).rejects.toThrow('b');
    await publisher.publish(raw);

    expect(publisher.rawMessages).toEqual([raw]);
    publisher.failNextWith(new Error('c'));
    publisher.clear();
    await publisher.publishEvent(videoUploadedFixture);
    expect(publisher.rawMessages).toEqual([]);
    expect(publisher.events).toHaveLength(1);
  });
});
