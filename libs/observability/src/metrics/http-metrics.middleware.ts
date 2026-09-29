import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry } from '@prometheus-io/client';
import { matchesPathPrefix } from '../http/path-prefix';
import { DEFAULT_IGNORED_PATHS } from '../logging/pino.config';
import { HttpMetrics } from './http-metrics';

/** Label `route` de requisição que não casou com nenhuma rota do Nest (404, estáticos, CORS). */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * Label `status` de requisição cujo cliente desconectou antes da resposta (convenção do NGINX).
 * Não é 5xx, então não pesa no SLO de disponibilidade.
 */
export const CLIENT_CLOSED_REQUEST_STATUS = 499;

/** Label `method` de métodos fora da lista (evita cardinalidade livre vinda da borda). */
export const OTHER_METHOD = 'OTHER';

const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/** Campos que o Express acrescenta à requisição (sem depender dos tipos do Express). */
export interface RoutedRequest extends IncomingMessage {
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: unknown };
}

export interface HttpMetricsMiddlewareOptions {
  /**
   * Prefixos fora da métrica. Padrão: {@link DEFAULT_IGNORED_PATHS} (health e docs), para as
   * probes do Kubernetes não diluírem o SLI de disponibilidade.
   */
  ignorePaths?: readonly string[];
  /** Relógio monotônico em nanossegundos (testes). */
  now?: () => bigint;
}

/**
 * Padrão de rota que atendeu a requisição, com o prefixo global (`/api/videos/:id`). Vem do
 * `req.route` que o Express preenche ao casar a rota registrada pelo Nest, então nunca contém
 * ids nem query string. Sem rota → {@link UNMATCHED_ROUTE}.
 */
export function resolveHttpRoute(req: RoutedRequest): string {
  const path = req.route?.path;
  if (typeof path !== 'string') return UNMATCHED_ROUTE;
  return `${req.baseUrl ?? ''}${path}` || '/';
}

export function normalizeHttpMethod(method: string | undefined): string {
  const upper = (method ?? '').toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : OTHER_METHOD;
}

/**
 * Middleware HTTP (Express/Nest) que mede `fiapx_http_request_duration_seconds{method,route,status}`
 * (contratos.md, seção 13). Registrar no video-api com `app.use(...)` ANTES de `app.init()`, junto
 * do `correlationIdMiddleware`:
 *
 * ```ts
 * app.use(createHttpMetricsMiddleware(app.get<Registry>(METRICS_REGISTRY)));
 * ```
 *
 * Por ser middleware (e não interceptor), mede também o que guards, pipes e o filtro global de
 * exceções respondem (401 do JWT, 429 do throttler, 413 do upload). A observação acontece no
 * `close` da resposta, quando o Express já casou a rota; cliente que desconecta antes da resposta
 * vira `status="499"`.
 */
export function createHttpMetricsMiddleware(
  target: Registry | HttpMetrics,
  options: HttpMetricsMiddlewareOptions = {},
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const metrics = target instanceof HttpMetrics ? target : new HttpMetrics(target);
  const ignorePaths = options.ignorePaths ?? DEFAULT_IGNORED_PATHS;
  const now = options.now ?? (() => process.hrtime.bigint());

  return (req: RoutedRequest, res: ServerResponse, next: () => void) => {
    if (matchesPathPrefix(req.originalUrl ?? req.url, ignorePaths)) {
      next();
      return;
    }

    const startedAt = now();
    res.once('close', () => {
      const seconds = Number(now() - startedAt) / 1e9;
      metrics.observe(
        {
          method: normalizeHttpMethod(req.method),
          route: resolveHttpRoute(req),
          status: res.writableFinished ? res.statusCode : CLIENT_CLOSED_REQUEST_STATUS,
        },
        seconds,
      );
    });
    next();
  };
}
