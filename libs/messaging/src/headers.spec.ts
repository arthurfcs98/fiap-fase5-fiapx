import { MESSAGE_HEADERS, readRetryCount, retryHeaders } from './headers';

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
