import { z } from 'zod';
import { AppErrorException } from '../errors/app-error.exception';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.object({
  email: z.email(),
  page: z.coerce.number().int().min(1).default(1),
  nested: z.object({ name: z.string().min(1) }).optional(),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('devolve o valor validado e transformado', () => {
    expect(pipe.transform({ email: 'a@b.com', page: '2' })).toEqual({ email: 'a@b.com', page: 2 });
  });

  it('inválido → 400 X0001 VALIDATION com a lista de campos', () => {
    let error: unknown;
    try {
      pipe.transform({ email: 'x', page: 0, nested: { name: '' } });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(AppErrorException);
    const appError = (error as AppErrorException).appError;
    expect(appError.httpStatus).toBe(400);
    expect(appError.code).toBe('X0001');
    expect(appError.metadata['fields']).toEqual([
      { field: 'email', message: expect.any(String) },
      { field: 'page', message: expect.any(String) },
      { field: 'nested.name', message: expect.any(String) },
    ]);
  });

  it('erro na raiz usa "(raiz)"', () => {
    expect(() => new ZodValidationPipe(z.string()).transform(1)).toThrow(AppErrorException);
    try {
      new ZodValidationPipe(z.string()).transform(1);
    } catch (e) {
      expect((e as AppErrorException).appError.metadata['fields']).toEqual([
        { field: '(raiz)', message: expect.any(String) },
      ]);
    }
  });
});
