import { isConnectivityError } from './connectivity';

function withCode(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

describe('isConnectivityError', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'])(
    'reconhece o código de rede %s',
    (code) => {
      expect(isConnectivityError(withCode(code))).toBe(true);
    },
  );

  it.each(['08006', '08001', '57P01', '57P03', '53300'])(
    'reconhece o SQLSTATE %s do Postgres (servidor indisponível)',
    (code) => {
      expect(isConnectivityError(withCode(code, 'pg'))).toBe(true);
    },
  );

  it.each([
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
    'socket hang up',
  ])('reconhece a mensagem do pg/pg-pool "%s"', (message) => {
    expect(isConnectivityError(new Error(message))).toBe(true);
  });

  it('procura no driverError (QueryFailedError do TypeORM), no cause e no AggregateError', () => {
    expect(isConnectivityError({ driverError: withCode('ECONNREFUSED') })).toBe(true);
    expect(isConnectivityError(new Error('storage', { cause: withCode('ENOTFOUND') }))).toBe(true);
    expect(isConnectivityError(new AggregateError([withCode('ECONNREFUSED')], 'connect'))).toBe(
      true,
    );
  });

  it('não confunde erros da requisição com queda da dependência', () => {
    expect(isConnectivityError(withCode('23505', 'duplicate key'))).toBe(false);
    expect(isConnectivityError(withCode('ENOSPC'))).toBe(false);
    expect(isConnectivityError(new Error('boom'))).toBe(false);
    expect(isConnectivityError({ code: 42 })).toBe(false);
    expect(isConnectivityError('ECONNREFUSED')).toBe(false);
    expect(isConnectivityError(null)).toBe(false);
  });

  it('para em ciclos e em cadeias profundas demais', () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isConnectivityError(cyclic)).toBe(false);

    let deep: unknown = withCode('ECONNREFUSED');
    for (let i = 0; i < 10; i += 1) deep = { cause: deep };
    expect(isConnectivityError(deep)).toBe(false);
  });
});
