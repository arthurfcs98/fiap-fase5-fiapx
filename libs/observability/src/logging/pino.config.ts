import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import type { Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { destination, stdTimeFunctions } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import { CORRELATION_ID_HEADER, getCorrelationId, resolveCorrelationId } from '../correlation';

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

/**
 * Campos mascarados em qualquer log (headers de auth, cookies, senhas, tokens), até dois
 * níveis abaixo da raiz (ex.: `req.body.password`, `user.credentials.token`).
 */
export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'authorization',
  'password',
  '*.password',
  '*.*.password',
  'token',
  '*.token',
  '*.*.token',
  'accessToken',
  '*.accessToken',
  '*.*.accessToken',
  'secret',
  '*.secret',
  '*.*.secret',
];

type RequestWithId = IncomingMessage & { id?: unknown };

/** Adiciona o correlation id do AsyncLocalStorage a todo log emitido dentro do contexto. */
export function correlationMixin(): Record<string, string> {
  const correlationId = getCorrelationId();
  return correlationId ? { correlationId } : {};
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
  const path = (url ?? '').split('?')[0] ?? '';
  return ignorePaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Opções do pino-http (portadas da Fase 3, agora parametrizadas por serviço):
 * - JSON em uma linha por evento, `level` como texto e `time` em ISO-8601;
 * - `service`, `version`, `hostname` e `pid` em todo log;
 * - `correlationId` em todo log: no acesso HTTP vem do `req.id` (header `x-correlation-id`
 *   recebido ou UUID novo, devolvido na resposta); nos demais, do AsyncLocalStorage;
 * - sem log de acesso para health/métricas/docs; 5xx em `error`, 4xx em `warn`;
 * - mascaramento de Authorization, cookies, senhas e tokens.
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
    redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
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
