import { decideRetry } from './retry-decision';

describe('decideRetry (regressão da Fase 4: o contador sempre avança)', () => {
  const queue = 'worker.video-uploaded';

  it('faz 3 retries com TTL crescente e manda a 4ª falha para o DLX', () => {
    expect(decideRetry(queue, 0)).toEqual({
      action: 'retry',
      retryQueue: 'worker.video-uploaded.retry.1',
      nextRetryCount: 1,
      delayMs: 5_000,
    });
    expect(decideRetry(queue, 1)).toMatchObject({
      retryQueue: `${queue}.retry.2`,
      delayMs: 30_000,
    });
    expect(decideRetry(queue, 2)).toMatchObject({
      retryQueue: `${queue}.retry.3`,
      delayMs: 120_000,
    });
    expect(decideRetry(queue, 3)).toEqual({ action: 'dead-letter' });
    expect(decideRetry(queue, 10)).toEqual({ action: 'dead-letter' });
  });

  it('simulação: falha transitória constante chama o handler exatamente 4 vezes', () => {
    let retryCount = 0;
    let handlerCalls = 0;
    for (;;) {
      handlerCalls += 1;
      const decision = decideRetry(queue, retryCount);
      if (decision.action === 'dead-letter') break;
      retryCount = decision.nextRetryCount;
    }
    expect(handlerCalls).toBe(4);
  });

  it.each([-1, 1.5, Number.NaN])('trata contagem inválida %p como 0', (count) => {
    expect(decideRetry(queue, count)).toMatchObject({ action: 'retry', nextRetryCount: 1 });
  });
});
