import { AppError } from './app-error';

describe('AppError', () => {
  it('expõe status, identificador, código, descrição e metadata', () => {
    const error = new AppError(404, 'VIDEO_NOT_FOUND', 'V0001', 'Vídeo não encontrado.', {
      id: 'abc',
    });

    expect(error.httpStatus).toBe(404);
    expect(error.toPayload()).toEqual({
      message: 'VIDEO_NOT_FOUND',
      code: 'V0001',
      description: 'Vídeo não encontrado.',
      metadata: { id: 'abc' },
    });
  });

  it('usa metadata vazia por padrão', () => {
    expect(new AppError(500, 'INTERNAL_ERROR', 'X0002', 'x').metadata).toEqual({});
  });

  it.each(['C0001', 'V001', 'v0001', 'X00001', ''])('rejeita código fora do padrão: %p', (code) => {
    expect(() => new AppError(400, 'ANY', code, 'x')).toThrow(/Código de erro inválido/);
  });
});
