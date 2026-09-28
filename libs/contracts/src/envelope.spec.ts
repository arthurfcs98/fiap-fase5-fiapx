import { z } from 'zod';
import {
  CORRELATION_ID_MAX_LENGTH,
  createEnvelope,
  eventEnvelopeSchema,
  parseEvent,
} from './envelope';

const pingEvent = eventEnvelopeSchema('test.ping', z.object({ n: z.number() }));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('createEnvelope', () => {
  it('gera id UUID v4, versão 1 e occurredAt ISO', () => {
    const envelope = createEnvelope({
      type: 'test.ping',
      payload: { n: 1 },
      correlationId: 'cid-1',
    });

    expect(pingEvent.parse(envelope)).toEqual(envelope);
    expect(envelope.id).toMatch(UUID_V4);
    expect(envelope.version).toBe(1);
    expect(new Date(envelope.occurredAt).toISOString()).toBe(envelope.occurredAt);
  });

  it('aceita id e relógio injetados', () => {
    const envelope = createEnvelope({
      type: 'test.ping',
      payload: { n: 2 },
      correlationId: 'cid-2',
      id: '00000000-0000-4000-8000-000000000001',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(envelope).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('parseEvent', () => {
  const valid = createEnvelope({ type: 'test.ping', payload: { n: 3 }, correlationId: 'cid-3' });

  it('aceita Buffer, string e objeto', () => {
    expect(parseEvent(pingEvent, Buffer.from(JSON.stringify(valid)))).toEqual({
      success: true,
      event: valid,
    });
    expect(parseEvent(pingEvent, JSON.stringify(valid)).success).toBe(true);
    expect(parseEvent(pingEvent, valid).success).toBe(true);
  });

  it('rejeita JSON inválido', () => {
    expect(parseEvent(pingEvent, Buffer.from('{nao-json'))).toEqual({
      success: false,
      error: 'corpo da mensagem não é JSON válido',
    });
  });

  it('descreve os campos inválidos', () => {
    const result = parseEvent(pingEvent, { ...valid, type: 'outro', payload: { n: 'x' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('type');
    expect(result.error).toContain('payload.n');
  });

  it('usa "(raiz)" quando o corpo nem é objeto', () => {
    expect(parseEvent(pingEvent, 42)).toMatchObject({
      success: false,
      error: expect.stringContaining('(raiz)'),
    });
  });

  it('rejeita versão diferente de 1', () => {
    expect(parseEvent(pingEvent, { ...valid, version: 2 }).success).toBe(false);
  });

  it('limita o correlationId ao tamanho da coluna do outbox (100)', () => {
    expect(CORRELATION_ID_MAX_LENGTH).toBe(100);
    const at = (length: number) => ({ ...valid, correlationId: 'c'.repeat(length) });
    expect(parseEvent(pingEvent, at(100)).success).toBe(true);
    expect(parseEvent(pingEvent, at(101))).toMatchObject({
      success: false,
      error: expect.stringContaining('correlationId'),
    });
  });
});
