import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { defer, lastValueFrom, of, throwError } from 'rxjs';
import { getCorrelationId } from './correlation-context';
import { CorrelationIdInterceptor } from './correlation-id.interceptor';

function httpContext(req: Record<string, unknown>, res: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

const handlerReadingCorrelation: CallHandler = {
  handle: () => defer(() => of(getCorrelationId())),
};

describe('CorrelationIdInterceptor', () => {
  const interceptor = new CorrelationIdInterceptor();

  it('reaproveita o req.id do pino-http e expõe o id no ALS, no request e na resposta', async () => {
    const req = { id: 'pino-id', headers: {} as Record<string, string> };
    const res = { setHeader: jest.fn() };

    const seen = await lastValueFrom(
      interceptor.intercept(httpContext(req, res), handlerReadingCorrelation),
    );

    expect(seen).toBe('pino-id');
    expect(req.headers['x-correlation-id']).toBe('pino-id');
    expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', 'pino-id');
  });

  it('usa o header recebido quando não há req.id', async () => {
    const req = { headers: { 'x-correlation-id': 'do-cliente' } };
    const res = { setHeader: jest.fn() };

    const seen = await lastValueFrom(
      interceptor.intercept(httpContext(req, res), handlerReadingCorrelation),
    );

    expect(seen).toBe('do-cliente');
  });

  it('gera um id novo quando o header é inseguro e não sobrescreve resposta já enviada', async () => {
    const req = { headers: { 'x-correlation-id': 'inválido com espaço' } };
    const res = { headersSent: true, setHeader: jest.fn() };

    const seen = await lastValueFrom(
      interceptor.intercept(httpContext(req, res), handlerReadingCorrelation),
    );

    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('propaga erros do handler', async () => {
    const res = { setHeader: jest.fn() };
    const failing: CallHandler = { handle: () => throwError(() => new Error('falhou')) };

    await expect(
      lastValueFrom(interceptor.intercept(httpContext({ headers: {} }, res), failing)),
    ).rejects.toThrow('falhou');
  });

  it('não interfere em contextos que não são HTTP', async () => {
    const context = { getType: () => 'rpc' } as unknown as ExecutionContext;
    const seen = await lastValueFrom(interceptor.intercept(context, handlerReadingCorrelation));
    expect(seen).toBeUndefined();
  });
});
