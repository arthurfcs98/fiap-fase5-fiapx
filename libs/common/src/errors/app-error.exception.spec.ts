import { HttpException } from '@nestjs/common';
import { AppError } from './app-error';
import { AppErrorException } from './app-error.exception';

describe('AppErrorException', () => {
  it('é uma HttpException com o status e o payload do AppError', () => {
    const appError = new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'A0002', 'Já existe.');
    const exception = new AppErrorException(appError);

    expect(exception).toBeInstanceOf(HttpException);
    expect(exception.getStatus()).toBe(409);
    expect(exception.getResponse()).toEqual({ error: appError.toPayload() });
    expect(exception.appError).toBe(appError);
  });
});
