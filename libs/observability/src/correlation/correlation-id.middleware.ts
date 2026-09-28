import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CORRELATION_ID_HEADER,
  correlationStorage,
  resolveCorrelationId,
} from './correlation-context';

/**
 * Middleware HTTP que abre o contexto de correlação (AsyncLocalStorage) para a requisição
 * INTEIRA: demais middlewares, guards, pipes, handler e também os filtros de exceção. Sem ele,
 * o contexto só existiria dentro do interceptor, e a linha de log do erro 5xx (a que tem o
 * stack) sairia sem `correlationId`.
 *
 * Registrar com `app.use(correlationIdMiddleware)` ANTES de `app.init()` (ver
 * `configureApp` do video-api): assim ele roda antes do pino-http do nestjs-pino. O id
 * resolvido é gravado no header da requisição, então o `genReqId` do pino-http reaproveita o
 * mesmo valor: log de acesso, logs da aplicação e header da resposta carregam um id só.
 */
export function correlationIdMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
): void {
  const correlationId = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
  req.headers[CORRELATION_ID_HEADER] = correlationId;
  if (!res.headersSent) res.setHeader(CORRELATION_ID_HEADER, correlationId);
  correlationStorage.run({ correlationId }, next);
}
