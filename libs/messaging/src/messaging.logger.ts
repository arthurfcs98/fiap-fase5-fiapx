import type { LoggerService } from '@nestjs/common';
import { Logger } from '@nestjs/common';

/**
 * Logger usado pela lib. O padrão é o `Logger` do Nest, que nos apps vira o pino (nestjs-pino)
 * e herda o `correlationId` do AsyncLocalStorage. Objetos com `msg` viram logs estruturados.
 */
export type MessagingLogger = Pick<LoggerService, 'log' | 'warn' | 'error'>;

export function defaultLogger(context: string): MessagingLogger {
  return new Logger(context);
}

/** Resumo curto e sem stack de um erro (para logs e para o header `x-last-error`). */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
