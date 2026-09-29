import { InvalidEventError, PublishError, UnroutableMessageError } from './messaging.errors';

describe('erros de mensageria', () => {
  it('PublishError carrega destino e causa', () => {
    const cause = new Error('nack');
    const error = new PublishError('fiapx.events', 'video.uploaded', { cause });
    expect(error).toMatchObject({
      name: 'PublishError',
      exchange: 'fiapx.events',
      routingKey: 'video.uploaded',
      cause,
    });
    expect(error.message).toContain('video.uploaded');
  });

  it('UnroutableMessageError é um PublishError e nomeia a default exchange', () => {
    const error = new UnroutableMessageError('', 'fila.x');
    expect(error).toBeInstanceOf(PublishError);
    expect(error.name).toBe('UnroutableMessageError');
    expect(error.message).toBe('Mensagem sem rota em "(default)" com routing key "fila.x"');
    expect(new UnroutableMessageError('fiapx.events', 'k').message).toContain('"fiapx.events"');
  });

  it('InvalidEventError descreve o type e o motivo', () => {
    const error = new InvalidEventError('video.uploaded', 'payload.videoId: inválido');
    expect(error).toMatchObject({ name: 'InvalidEventError', eventType: 'video.uploaded' });
    expect(error.message).toBe('Evento inválido (video.uploaded): payload.videoId: inválido');
  });
});
