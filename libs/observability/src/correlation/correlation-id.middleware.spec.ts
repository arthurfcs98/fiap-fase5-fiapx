import type { IncomingMessage, ServerResponse } from 'node:http';
import { getCorrelationId } from './correlation-context';
import { correlationIdMiddleware } from './correlation-id.middleware';

function fakeRequest(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function fakeResponse(headersSent = false) {
  const setHeader = jest.fn();
  return { res: { headersSent, setHeader } as unknown as ServerResponse, setHeader };
}

describe('correlationIdMiddleware', () => {
  it('reaproveita o id recebido, grava no request e na resposta e roda o next() no contexto', () => {
    const req = fakeRequest({ 'x-correlation-id': 'cid-borda' });
    const { res, setHeader } = fakeResponse();
    let seen: string | undefined;

    correlationIdMiddleware(req, res, () => {
      seen = getCorrelationId();
    });

    expect(seen).toBe('cid-borda');
    expect(req.headers['x-correlation-id']).toBe('cid-borda');
    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', 'cid-borda');
    expect(getCorrelationId()).toBeUndefined();
  });

  it('mantém o contexto em continuações assíncronas do next()', async () => {
    const { res } = fakeResponse();
    const seen = await new Promise<string | undefined>((resolve) => {
      correlationIdMiddleware(fakeRequest({ 'x-correlation-id': 'cid-async' }), res, () => {
        setTimeout(() => resolve(getCorrelationId()), 1);
      });
    });
    expect(seen).toBe('cid-async');
  });

  it('gera um UUID para header inseguro e não mexe em resposta já enviada', () => {
    const req = fakeRequest({ 'x-correlation-id': 'a'.repeat(101) });
    const { res, setHeader } = fakeResponse(true);
    let seen: string | undefined;

    correlationIdMiddleware(req, res, () => {
      seen = getCorrelationId();
    });

    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.headers['x-correlation-id']).toBe(seen);
    expect(setHeader).not.toHaveBeenCalled();
  });
});
