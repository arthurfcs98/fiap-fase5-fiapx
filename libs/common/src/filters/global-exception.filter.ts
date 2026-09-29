import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { AppErrorPayload } from '../errors/app-error';
import { AppErrorException } from '../errors/app-error.exception';
import { AuthErrors } from '../errors/catalog/auth.errors';
import { CommonErrors } from '../errors/catalog/common.errors';
import { VideoErrors } from '../errors/catalog/video.errors';
import { isConnectivityError } from '../errors/connectivity';

export interface ErrorResponseBody {
  statusCode: number;
  error: AppErrorPayload;
  timestamp: string;
  path: string;
  correlationId?: string;
}

interface RequestLike {
  id?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

interface NormalizedError {
  status: number;
  payload: AppErrorPayload;
}

/**
 * HttpException genérica cujo status já tem código no catálogo (contratos.md, seção 4):
 * 401 do Passport/guards → `A0003 UNAUTHORIZED`; 413 do parser/multer/busboy → `V0003`.
 */
const CATALOG_BY_STATUS: Readonly<Partial<Record<number, () => AppErrorException>>> = {
  [HttpStatus.UNAUTHORIZED]: () => AuthErrors.UNAUTHORIZED(),
  [HttpStatus.PAYLOAD_TOO_LARGE]: () => VideoErrors.FILE_TOO_LARGE(),
};

/** `Retry-After` of a `503 X0003` caused by a dependency that could not be reached. */
export const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

/**
 * Filtro global (portado da Fase 2): toda resposta de erro sai no mesmo envelope
 * `{ statusCode, error: { message, code, description, metadata }, timestamp, path, correlationId }`.
 *
 * - `AppErrorException` → payload do catálogo (A/V/P/X).
 * - `HttpException` com `message` em array (class-validator) → `X0001 VALIDATION`.
 * - `HttpException` 401 → `A0003 UNAUTHORIZED`; 413 → `V0003 FILE_TOO_LARGE`.
 * - Outra `HttpException` → `X0<status>` com o nome do status (ex.: `X0404 NOT_FOUND`); campos
 *   extras do corpo vão para `metadata`.
 * - Dependência inalcançável (Postgres fora, conexão recusada/encerrada: `isConnectivityError`)
 *   → `503 X0003` com `Retry-After`, e não 500: o cliente pode tentar de novo.
 * - Qualquer outra coisa → `X0002 INTERNAL`, sem vazar detalhes, com log do stack.
 *
 * `path` sai SEM a query string: a do download carrega a assinatura HMAC do link.
 *
 * Log: 5xx em `error` com stack, exceto 503 (dependência fora, ex.: readiness do Terminus
 * durante uma queda do banco), que vai em `warn` sem stack para não inundar os logs a cada
 * probe. O `correlationId` do log vem do contexto aberto pelo `correlationIdMiddleware`.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<RequestLike>();
    const response: unknown = ctx.getResponse();

    const { status, payload } = GlobalExceptionFilter.normalize(exception);

    if (status >= 500) this.logServerError(status, payload, exception);

    const retryAfter = payload.metadata['retryAfterSeconds'];
    if (typeof retryAfter === 'number') {
      httpAdapter.setHeader(response, 'Retry-After', String(retryAfter));
    }

    const body: ErrorResponseBody = {
      statusCode: status,
      error: payload,
      timestamp: new Date().toISOString(),
      path: withoutQuery(String(httpAdapter.getRequestUrl(request))),
    };
    const correlationId = extractCorrelationId(request);
    if (correlationId) body.correlationId = correlationId;

    httpAdapter.reply(response, body, status);
  }

  private logServerError(status: number, payload: AppErrorPayload, exception: unknown): void {
    const summary = `${payload.code} ${payload.message}: ${describe(exception)}`;
    if (status === Number(HttpStatus.SERVICE_UNAVAILABLE)) {
      this.logger.warn(summary);
      return;
    }
    const stack = exception instanceof Error ? exception.stack : String(exception);
    this.logger.error(summary, stack);
  }

  static normalize(exception: unknown): NormalizedError {
    if (exception instanceof AppErrorException) {
      return { status: exception.appError.httpStatus, payload: exception.appError.toPayload() };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const body = typeof response === 'object' && response !== null ? response : undefined;
      const bodyMessage = body ? (body as Record<string, unknown>)['message'] : undefined;

      if (Array.isArray(bodyMessage)) {
        return {
          status,
          payload: {
            message: 'VALIDATION',
            code: 'X0001',
            description: 'Dados inválidos.',
            metadata: { fields: bodyMessage },
          },
        };
      }

      const fromCatalog = CATALOG_BY_STATUS[status];
      if (fromCatalog) return { status, payload: fromCatalog().appError.toPayload() };

      const description =
        typeof response === 'string'
          ? response
          : typeof bodyMessage === 'string'
            ? bodyMessage
            : exception.message;

      return {
        status,
        payload: {
          message: statusName(status),
          code: `X${String(status).padStart(4, '0')}`,
          description,
          metadata: body ? extraFields(body) : {},
        },
      };
    }

    if (isConnectivityError(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        payload: CommonErrors.UNAVAILABLE(DEPENDENCY_RETRY_AFTER_SECONDS).appError.toPayload(),
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      payload: {
        message: 'INTERNAL',
        code: 'X0002',
        description: 'Erro interno inesperado.',
        metadata: {},
      },
    };
  }
}

function withoutQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

function statusName(status: number): string {
  const name = (HttpStatus as unknown as Record<number, string | undefined>)[status];
  return name ?? 'HTTP_ERROR';
}

/** Campos do corpo além do envelope padrão do Nest (`statusCode`, `message`, `error: string`). */
function extraFields(body: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) =>
        key !== 'statusCode' &&
        key !== 'message' &&
        !(key === 'error' && typeof value === 'string'),
    ),
  );
}

function extractCorrelationId(request: RequestLike): string | undefined {
  if (typeof request.id === 'string' && request.id.length > 0) return request.id;
  const header = request.headers?.['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : undefined;
}

function describe(exception: unknown): string {
  return exception instanceof Error ? exception.message : String(exception);
}
