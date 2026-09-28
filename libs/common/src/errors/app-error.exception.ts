import { HttpException } from '@nestjs/common';
import type { AppError } from './app-error';

/** Exceção HTTP que carrega um {@link AppError}; o GlobalExceptionFilter a serializa. */
export class AppErrorException extends HttpException {
  constructor(public readonly appError: AppError) {
    super({ error: appError.toPayload() }, appError.httpStatus);
  }
}
