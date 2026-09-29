import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import type { Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { destination, stdTimeFunctions } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import { CORRELATION_ID_HEADER, getCorrelationId, resolveCorrelationId } from '../correlation';
import { matchesPathPrefix } from '../http/path-prefix';
import { LOG_REDACT_CENSOR, REDACTED_PATHS } from './redaction';

export interface PinoConfigOptions {
  /** Nome do serviço, gravado em todo log (`service`). */
  serviceName: string;
  /** Revisão de build (`version`), para correlacionar logs com o deploy. */
  version?: string;
  level?: string;
  /** Prefixos de URL que não geram log de acesso (health, métricas, docs). */
  ignorePaths?: readonly string[];
  /** Destino dos logs. Padrão: stdout SÍNCRONO (ver {@link createPinoConfig}). */
  destination?: DestinationStream;
}

export const DEFAULT_IGNORED_PATHS: readonly string[] = [
  '/api/health',
  '/health',
  '/metrics',
  '/api/docs',
];

type RequestWithId = IncomingMessage & { id?: unknown };

/** Adiciona o correlation id do AsyncLocalStorage a todo log emitido dentro do contexto. */
export function correlationMixin(): Record<string, string> {
  const correlationId = getCorrelationId();
  return correlationId ? { correlationId } : {};
}

/** Standard-serialized request (pino-std-serializers) received by a custom serializer. */
interface SerializedRequest {
  id?: unknown;
  method?: string;
  url?: string;
  remoteAddress?: string;
}

/**
 * Access-log request: id, method, path and client address only. The query string is dropped
 * (it carries the HMAC signature of the download links, a 5-minute bearer credential) and so
 * are the headers (they may carry personal data; Authorization/Cookie were already masked).
 */
export function serializeAccessRequest(req: SerializedRequest): Record<string, unknown> {
  return {
    id: req.id,
    method: req.method,
    url: req.url?.split('?', 1)[0],
    remoteAddress: req.remoteAddress,
  };
}

/**
 * Access-log response: status code only. Response headers are dropped: `Content-Disposition`
 * carries the file name the user chose (personal data, contratos.md section 12).
 */
export function serializeAccessResponse(res: { statusCode?: number }): Record<string, unknown> {
  return { statusCode: res.statusCode };
}

/** 5xx/erro → error, 4xx → warn, demais → info. */
export function accessLogLevel(
  _req: IncomingMessage,
  res: ServerResponse,
  error?: Error,
): 'error' | 'warn' | 'info' {
  if (error || res.statusCode >= 500) return 'error';
  if (res.statusCode >= 400) return 'warn';
  return 'info';
}

export function shouldSkipAccessLog(
  url: string | undefined,
  ignorePaths: readonly string[],
): boolean {
  return matchesPathPrefix(url, ignorePaths);
}

/**
 * Opções do pino-http (portadas da Fase 3, agora parametrizadas por serviço):
 * - JSON em uma linha por evento, `level` como texto e `time` em ISO-8601;
 * - `service`, `version`, `hostname` e `pid` em todo log;
 * - `correlationId` em todo log: no acesso HTTP vem do `req.id` (header `x-correlation-id`
 *   recebido ou UUID novo, devolvido na resposta); nos demais, do AsyncLocalStorage;
 * - sem log de acesso para health/métricas/docs; 5xx em `error`, 4xx em `warn`;
 * - mascaramento de Authorization, cookies, senhas, tokens e dados pessoais (`REDACTED_PATHS`,
 *   LGPD, contratos.md seção 12);
 * - access log reduced to id/method/path/client address and the status code (no query string,
 *   no headers): see `serializeAccessRequest` and `serializeAccessResponse`.
 */
export function createPinoHttpOptions(options: PinoConfigOptions): PinoHttpOptions {
  const ignorePaths = options.ignorePaths ?? DEFAULT_IGNORED_PATHS;

  return {
    level: options.level ?? 'info',
    base: {
      service: options.serviceName,
      version: options.version ?? 'dev',
      hostname: hostname(),
      pid: process.pid,
    },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    mixin: correlationMixin,
    redact: { paths: [...REDACTED_PATHS], censor: LOG_REDACT_CENSOR },
    serializers: { req: serializeAccessRequest, res: serializeAccessResponse },
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const correlationId = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
      res.setHeader(CORRELATION_ID_HEADER, correlationId);
      return correlationId;
    },
    customLogLevel: accessLogLevel,
    customSuccessObject: (req: RequestWithId, _res: ServerResponse, value: object) => ({
      ...value,
      correlationId: req.id,
    }),
    customErrorObject: (
      req: RequestWithId,
      _res: ServerResponse,
      _error: Error,
      value: object,
    ) => ({
      ...value,
      correlationId: req.id,
    }),
    autoLogging: {
      ignore: (req: IncomingMessage) => shouldSkipAccessLog(req.url, ignorePaths),
    },
  };
}

/**
 * Configuração do `LoggerModule` (nestjs-pino).
 *
 * O destino padrão é stdout SÍNCRONO: no SIGTERM o Nest fecha a aplicação e reenvia o sinal
 * ao próprio processo, que morre na hora. Com o stdout assíncrono padrão do pino, as últimas
 * linhas (justamente as do shutdown) se perdiam. O custo de escrita síncrona é irrelevante no
 * volume deste projeto.
 */
export function createPinoConfig(options: PinoConfigOptions): Params {
  return {
    pinoHttp: [
      createPinoHttpOptions(options),
      options.destination ?? destination({ dest: 1, sync: true }),
    ],
  };
}
