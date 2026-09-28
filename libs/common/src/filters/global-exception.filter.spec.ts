import type { ArgumentsHost } from '@nestjs/common';
import {
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { CommonErrors, VideoErrors } from '../errors/catalog';
import type { ErrorResponseBody } from './global-exception.filter';
import { GlobalExceptionFilter } from './global-exception.filter';

function setup(request: Record<string, unknown> = { id: 'req-123', headers: {} }) {
  const httpAdapter = {
    reply: jest.fn(),
    setHeader: jest.fn(),
    getRequestUrl: jest.fn(() => '/api/videos/1'),
  };
  const response = { fake: 'response' };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
  const filter = new GlobalExceptionFilter({ httpAdapter } as unknown as HttpAdapterHost);
  const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  const run = (exception: unknown) => {
    filter.catch(exception, host);
    const [res, body, status] = httpAdapter.reply.mock.calls[0] as [
      unknown,
      ErrorResponseBody,
      number,
    ];
    expect(res).toBe(response);
    return { body, status };
  };
  return { run, httpAdapter, errorLog, warnLog };
}

describe('GlobalExceptionFilter', () => {
  it('serializa AppErrorException com o payload do catálogo, path e correlationId', () => {
    const { run, errorLog } = setup();

    const { body, status } = run(VideoErrors.NOT_FOUND('v1'));

    expect(status).toBe(404);
    expect(body).toEqual({
      statusCode: 404,
      error: {
        message: 'VIDEO_NOT_FOUND',
        code: 'V0001',
        description: 'Vídeo não encontrado.',
        metadata: { id: 'v1' },
      },
      timestamp: expect.any(String),
      path: '/api/videos/1',
      correlationId: 'req-123',
    });
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('define Retry-After e loga 503 do catálogo em warn, sem stack', () => {
    const { run, httpAdapter, errorLog, warnLog } = setup();

    const { status, body } = run(CommonErrors.UNAVAILABLE(5));

    expect(status).toBe(503);
    expect(body.error.code).toBe('X0003');
    expect(httpAdapter.setHeader).toHaveBeenCalledWith(expect.anything(), 'Retry-After', '5');
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenCalledWith(expect.stringContaining('X0003 UNAVAILABLE'));
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('loga os demais 5xx do catálogo em error, com stack', () => {
    const { run, errorLog, warnLog } = setup();

    const { status, body } = run(CommonErrors.INTERNAL());

    expect(status).toBe(500);
    expect(body.error.code).toBe('X0002');
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('X0002 INTERNAL'),
      expect.any(String),
    );
    expect(warnLog).not.toHaveBeenCalled();
  });

  it('converte 401 genérico (Passport/guards) em A0003 UNAUTHORIZED', () => {
    const { run } = setup();

    const { body, status } = run(new UnauthorizedException());

    expect(status).toBe(401);
    expect(body.error).toEqual({
      message: 'UNAUTHORIZED',
      code: 'A0003',
      description: 'Autenticação necessária ou token inválido.',
      metadata: {},
    });
  });

  it('converte 413 genérico (parser/multer/busboy) em V0003 FILE_TOO_LARGE', () => {
    const { run } = setup();

    const { body, status } = run(new PayloadTooLargeException('request entity too large'));

    expect(status).toBe(413);
    expect(body.error).toEqual({
      message: 'FILE_TOO_LARGE',
      code: 'V0003',
      description: 'O arquivo excede o tamanho máximo permitido.',
      metadata: {},
    });
  });

  it('converte erros de validação (message em array) em X0001', () => {
    const { run } = setup();

    const { body, status } = run(new BadRequestException(['email must be an email']));

    expect(status).toBe(400);
    expect(body.error).toEqual({
      message: 'VALIDATION',
      code: 'X0001',
      description: 'Dados inválidos.',
      metadata: { fields: ['email must be an email'] },
    });
  });

  it('converte HttpException genérica em X0<status> com o nome do status', () => {
    const { run, httpAdapter } = setup();

    const { body, status } = run(new NotFoundException('Cannot GET /api/nada'));

    expect(status).toBe(404);
    expect(body.error).toEqual({
      message: 'NOT_FOUND',
      code: 'X0404',
      description: 'Cannot GET /api/nada',
      metadata: {},
    });
    expect(httpAdapter.setHeader).not.toHaveBeenCalled();
  });

  it('usa a string da resposta como descrição', () => {
    const { run } = setup();
    const { body } = run(new HttpException('Muitas requisições', 429));
    expect(body.error).toMatchObject({
      message: 'TOO_MANY_REQUESTS',
      code: 'X0429',
      description: 'Muitas requisições',
    });
  });

  it('preserva campos extras do corpo (ex.: detalhes do Terminus) em metadata', () => {
    const { run, errorLog, warnLog } = setup();
    const terminusBody = {
      status: 'error',
      info: {},
      error: { database: { status: 'down' } },
      details: { database: { status: 'down' } },
    };

    const { body, status } = run(new ServiceUnavailableException(terminusBody));

    expect(status).toBe(503);
    expect(body.error.code).toBe('X0503');
    expect(body.error.metadata).toEqual(terminusBody);
    // Readiness fora durante queda do banco: warn sem stack (o Terminus já detalha a falha).
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('usa exception.message e HTTP_ERROR para corpo sem message e status desconhecido', () => {
    const { run } = setup();

    const { body, status } = run(new HttpException({ foo: 'bar' }, 499));

    expect(status).toBe(499);
    expect(body.error).toEqual({
      message: 'HTTP_ERROR',
      code: 'X0499',
      description: 'Http Exception',
      metadata: { foo: 'bar' },
    });
  });

  it('esconde detalhes de erros inesperados (X0002) e loga o stack', () => {
    const { run, errorLog } = setup();

    const { body, status } = run(new Error('conexão recusada em 10.0.0.1'));

    expect(status).toBe(500);
    expect(body.error).toEqual({
      message: 'INTERNAL',
      code: 'X0002',
      description: 'Erro interno inesperado.',
      metadata: {},
    });
    expect(JSON.stringify(body)).not.toContain('10.0.0.1');
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('conexão recusada'),
      expect.stringContaining('Error: conexão recusada'),
    );
  });

  it('trata valores lançados que não são Error', () => {
    const { run, errorLog } = setup();
    const { status } = run('boom');
    expect(status).toBe(500);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('boom'), 'boom');
  });

  it('usa o header x-correlation-id quando o request não tem id', () => {
    const { run } = setup({ headers: { 'x-correlation-id': 'cid-1' } });
    expect(run(new NotFoundException()).body.correlationId).toBe('cid-1');
  });

  it('omite correlationId quando não há id nem header', () => {
    const { run } = setup({ id: '', headers: { 'x-correlation-id': ['a', 'b'] } });
    expect(run(new NotFoundException()).body).not.toHaveProperty('correlationId');
  });

  it('funciona com request sem headers', () => {
    const { run } = setup({});
    expect(run(new NotFoundException()).body).not.toHaveProperty('correlationId');
  });
});
