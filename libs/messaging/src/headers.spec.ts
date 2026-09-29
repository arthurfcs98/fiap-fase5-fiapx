import {
  effectiveRetryCount,
  MESSAGE_HEADERS,
  readDeliveryCount,
  readLastDeathReason,
  readOriginDeathReason,
  readRetryCount,
  retryHeaders,
  stripBrokerHeaders,
} from './headers';

describe('effectiveRetryCount', () => {
  it('vale o x-retry-count enquanto a mensagem circula entre a fila e as .retry.N', () => {
    expect(effectiveRetryCount({ 'x-retry-count': 2 })).toBe(2);
    expect(effectiveRetryCount({ 'x-retry-count': 2, 'x-last-death-reason': 'expired' })).toBe(2);
    expect(effectiveRetryCount(undefined)).toBe(0);
  });

  it.each(['rejected', 'delivery_limit', 'maxlen'])(
    'mensagem que chegou por dead-letter (%s) começa um ciclo novo',
    (reason) => {
      expect(effectiveRetryCount({ 'x-retry-count': 3, 'x-last-death-reason': reason })).toBe(0);
    },
  );
});

describe('readOriginDeathReason', () => {
  it('prefere o dead-letter atual; depois de um retry, o motivo guardado na cópia', () => {
    expect(readOriginDeathReason({ 'x-last-death-reason': 'rejected' })).toBe('rejected');
    expect(
      readOriginDeathReason({
        'x-last-death-reason': 'expired',
        [MESSAGE_HEADERS.originDeathReason]: 'delivery_limit',
      }),
    ).toBe('delivery_limit');
    expect(readOriginDeathReason({ 'x-last-death-reason': 'expired' })).toBe('expired');
    expect(readOriginDeathReason({ [MESSAGE_HEADERS.originDeathReason]: '' })).toBeUndefined();
    expect(readOriginDeathReason(undefined)).toBeUndefined();
  });
});

describe('readRetryCount', () => {
  it.each([
    [undefined, 0],
    [{}, 0],
    [{ 'x-retry-count': 2 }, 2],
    [{ 'x-retry-count': '3' }, 3],
    [{ 'x-retry-count': ' ' }, 0],
    [{ 'x-retry-count': 'abc' }, 0],
    [{ 'x-retry-count': -1 }, 0],
    [{ 'x-retry-count': 1.5 }, 0],
    [{ 'x-retry-count': null }, 0],
  ])('%p → %p', (headers, expected) => {
    expect(readRetryCount(headers as Record<string, unknown> | undefined)).toBe(expected);
  });
});

describe('retryHeaders', () => {
  it('grava o novo contador e a causa truncada, preservando os demais headers', () => {
    const original = { 'x-retry-count': 1, 'x-correlation-id': 'cid' };

    const next = retryHeaders(original, 2, 'x'.repeat(300));

    expect(next[MESSAGE_HEADERS.retryCount]).toBe(2);
    expect(next[MESSAGE_HEADERS.correlationId]).toBe('cid');
    expect((next[MESSAGE_HEADERS.lastError] as string).length).toBe(256);
    expect(original['x-retry-count']).toBe(1);
  });

  it('funciona sem headers de origem', () => {
    expect(retryHeaders(undefined, 1, 'timeout')).toEqual({
      'x-retry-count': 1,
      'x-last-error': 'timeout',
    });
  });
});

describe('stripBrokerHeaders', () => {
  it('remove x-death, x-*-death-* e contadores do broker, preservando o resto', () => {
    const headers = {
      'x-correlation-id': 'cid',
      'x-retry-count': 1,
      'x-death': [{ queue: 'q.retry.1', reason: 'expired' }],
      'x-first-death-queue': 'q.retry.1',
      'x-first-death-reason': 'expired',
      'x-first-death-exchange': '',
      'x-last-death-queue': 'q.retry.1',
      'x-last-death-reason': 'expired',
      'x-last-death-exchange': '',
      'x-delivery-count': 2,
      'x-acquired-count': 3,
    };

    expect(stripBrokerHeaders(headers)).toEqual({ 'x-correlation-id': 'cid', 'x-retry-count': 1 });
    expect(headers['x-death']).toBeDefined();
    expect(stripBrokerHeaders(undefined)).toEqual({});
  });
});

describe('readDeliveryCount', () => {
  it.each([
    [undefined, 0],
    [{}, 0],
    [{ 'x-delivery-count': 4 }, 4],
    [{ 'x-delivery-count': '4' }, 0],
    [{ 'x-delivery-count': -1 }, 0],
  ])('%p → %p', (headers, expected) => {
    expect(readDeliveryCount(headers as Record<string, unknown> | undefined)).toBe(expected);
  });
});

describe('readLastDeathReason', () => {
  it.each([
    [undefined, undefined],
    [{}, undefined],
    [{ 'x-last-death-reason': 'delivery_limit' }, 'delivery_limit'],
    [
      { 'x-last-death-reason': '', 'x-death': [{ reason: 'rejected' }, { reason: 'expired' }] },
      'rejected',
    ],
    [{ 'x-death': [] }, undefined],
    [{ 'x-death': 'x' }, undefined],
    [{ 'x-death': [null] }, undefined],
    [{ 'x-death': [{ reason: 1 }] }, undefined],
  ])('%p → %p', (headers, expected) => {
    expect(readLastDeathReason(headers as Record<string, unknown> | undefined)).toBe(expected);
  });
});
